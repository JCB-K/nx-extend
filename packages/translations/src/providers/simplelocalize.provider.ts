import { logger } from '@nrwl/devkit'
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import { existsSync } from 'fs'

import { DEEPL_SUPPORT_LANGUAGES } from '../translators/deepl.translator'
import { BaseConfigFile, updateConfigFile } from '../utils/config-file'
import BaseProvider from './base.provider'

export interface SimpleLocalizeConfig extends BaseConfigFile {
  tokenFrom?: string
  autoTranslate?: boolean
  publishAfterPush?: boolean
}

// TODO:: Add support to trigger auto translate
// https://simplelocalize.io/docs/api/auto-translate/
export default class SimpleLocalize extends BaseProvider<SimpleLocalizeConfig> {

  private readonly apiClient: AxiosInstance = axios.create({
    baseURL: 'https://api.simplelocalize.io/api/v1'
  })

  private authToken

  public async push() {
    await this.assureRequirementsExists()

    if (!existsSync(this.sourceFile)) {
      throw new Error('Source file does not exist!')
    }

    logger.info('Going to upload translations!')

    const sourceTerms = this.getSourceTerms()

    await this.uploadTranslations(this.config.defaultLanguage, sourceTerms)

    if (this.config.autoTranslate) {
      logger.info('Auto translate is enabled, starting it')

      for (const language of this.config.languages) {
        if (language !== this.config.defaultLanguage) {
          await this.autoTranslate(language)
        }
      }
    } else if (this.config.publishAfterPush) {
      logger.info('Publish after push is enabled, publishing latest changes')
      await this.post('/translations/publish', null, {
        headers: {
          'X-SimpleLocalize-Token': await this.getToken()
        }
      })
    }
  }

  public async getTranslations(language: string): Promise<{ [key: string]: string }> {
    const data = await this.get<any>(`https://cdn.simplelocalize.io/${this.config.projectId}/_latest/${language}`)

    const translations = {}

    Object.keys(data).forEach((term) => {
      translations[term] = data[term]
    })

    return translations
  }

  public async uploadTranslations(language: string, translations: { [key: string]: string }): Promise<boolean> {
    logger.info(`Adding translations to "${language}" language`)

    const terms = []
    Object.keys(translations).forEach((key) => {
      terms.push({
        key,
        language,
        text: translations[key]
      })
    })

    // TODO:: Add support for option to delete keys that no longer exists
    // If enabled, fetch current translations, then delete the ones that no longer exists
    // https://simplelocalize.io/docs/api/delete-translations/

    await this.post(
      '/translations',
      {
        content: terms
      },
      {
        headers: {
          'X-SimpleLocalize-Token': await this.getToken()
        }
      }
    )

    logger.info('Translations uploaded!')

    return true
  }

  protected async assureRequirementsExists() {
    await this.assureProjectExists()
    await this.assureLanguageExists()
  }

  private async assureProjectExists() {
    if (this.config.projectId) {
      return true
    }

    if (!this.config.projectName) {
      throw new Error('No "projectName" or "projectId" provided!')
    }

    const { data } = await this.get<any>('/projects', {
      headers: {
        Authorization: `Basic ${this.getBasicAuth()}`
      }
    })

    let project = data.find((project) => project.name === this.config.projectName)

    if (!project) {
      logger.info(`Project "${this.config.projectName}" does not exist, going to create it!`)

      const { data: { projectToken } } = await this.post<any>('/projects', {
        name: this.config.projectName
      }, {
        headers: {
          Authorization: `Basic ${this.getBasicAuth()}`
        }
      })

      project = {
        projectToken
      }

    } else {
      logger.info(`Found "${this.config.projectName}" project, storing id in config`)
    }

    // Update the config file
    await updateConfigFile(this.context, {
      projectId: project.projectToken
    })

    // Update the current config
    this.config = Object.assign(this.config, {
      projectId: project.projectToken
    })
  }

  private async assureLanguageExists() {
    if (!this.config.languages || this.config.languages.length === 0) {
      throw new Error('No "languages" defined!')
    }

    const { data } = await this.get<any>('/languages', {
      headers: {
        'X-SimpleLocalize-Token': await this.getToken()
      }
    })

    const existingCodes = data.map(({ key }) => key)

    const nonExistingCodes = [...this.config.languages]
      .filter((code) => !existingCodes.includes(code))

    while (nonExistingCodes.length > 0) {
      const key = nonExistingCodes.shift()
      logger.info(`Going add language "${key}" to project "${this.config.projectName}"`)

      await this.post('/languages', {
        key,
        name: `${key}-${key.toUpperCase()}`
      }, {
        headers: {
          'X-SimpleLocalize-Token': await this.getToken()
        }
      })
    }
  }

  private async getToken(): Promise<string> {
    if (this.authToken) {
      return this.authToken
    }

    const apiKey = this.config.tokenFrom
      ? process.env[this.config.tokenFrom]
      : process.env.NX_EXTEND_SIMPLE_LOCALIZE_TOKEN

    const basicAuth = process.env.NX_EXTEND_SIMPLE_BASIC_AUTH

    if (!apiKey) {
      // If we have basic auth, then get the project token
      if (basicAuth) {
        const { data: projects } = await this.get('/projects', {
          headers: {
            Authorization: `Basic ${basicAuth}`
          }
        })

        const project = projects.find(({ name }) => name === this.config.projectName)

        if (project) {
          return this.authToken = project.apiKey
        }
      }

      throw new Error(`No API key defined, please set "${this.config.tokenFrom || 'NX_EXTEND_SIMPLE_LOCALIZE_TOKEN'}"!`)
    }

    return apiKey
  }

  private getBasicAuth(): string {
    const basicAuth = process.env.NX_EXTEND_SIMPLE_BASIC_AUTH

    if (!basicAuth) {
      throw new Error(`No basic auth key defined, please set "NX_EXTEND_SIMPLE_BASIC_AUTH"!`)
    }

    return basicAuth
  }

  private async autoTranslate(language: string) {
    try {
      let translationProvider = this.config.translator.toUpperCase()

      if (translationProvider === 'DEEPL' && !DEEPL_SUPPORT_LANGUAGES.includes(language.toUpperCase())) {
        if (this.config.translatorOptions?.fallbackToGooleTranslate) {
          logger.warn(`Language "${language}" will use Google Translate as it's not supported by DeepL!`)
          translationProvider = 'GOOGLE_TRANSLATE'

        } else {
          logger.warn(`Skipping auto translate for "${language}" as it's not support by DeepL!`)
          return
        }
      }

      await this.post(
        '/jobs/auto-translate',
        {
          translationProvider,
          sourceProjectLanguage: this.config.defaultLanguage,
          deeplFormality: this.config?.translatorOptions?.formality ?? undefined,
          targetLanguage: language.toUpperCase(),
          targetProjectLanguage: language,
          options: this.config.publishAfterPush ? ['AUTO_PUBLISH'] : []
        },
        {
          headers: {
            'X-SimpleLocalize-Token': await this.getToken()
          }
        }
      )
    } catch (err) {
      logger.error(`Error starting auto translate for language "${language}"`)
      console.error(err)
    }
  }

  private async get<Data = any>(url: string, config?: AxiosRequestConfig<Data>, isRetry = false) {
    try {
      const response = await this.apiClient.get<Data>(
        url,
        config
      )

      return response.data
    } catch (err) {
      if (err.response.status === 429 && !isRetry) {
        const waitTime = err.response.headers['retry-after'] * 1000
        logger.debug(`Hit the rate limit, waiting ${waitTime} seconds...`)

        await new Promise((resolve) => setTimeout(resolve, waitTime))

        return this.get(url, config, true)
      } else {
        throw err
      }
    }
  }

  private async post<Data = any>(url: string, data: Data, config: AxiosRequestConfig<Data>, isRetry = false) {
    try {
      const response = await this.apiClient.post<Data>(
        url,
        data,
        config
      )

      return response.data
    } catch (err) {
      if (err.response.status === 429 && !isRetry) {
        const waitTime = err.response.headers['retry-after'] * 1000
        logger.debug(`Hit the rate limit, waiting ${waitTime} seconds...`)

        await new Promise((resolve) => setTimeout(resolve, waitTime))

        return this.get(url, config, true)
      } else {
        throw err
      }
    }
  }

}
