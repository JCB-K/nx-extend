import { readJsonFile,writeJsonFile } from '@nx/devkit'
import { basename } from 'path'

export interface SecretMetadata {
  status: 'encrypted' | 'decrypted'
  labels?: string[]
  onUpdateBehavior?: 'none' | 'delete' | 'disable'
  serviceAccounts?: string[]
  /**
   * If enabled, each key will create a secret
   */
  keysAreSecrets?: boolean
}

export interface SecretFile {
  __gcp_metadata: SecretMetadata

  [key: string]: any
}

export const getFileContent = (file: string): SecretFile => {
  return readJsonFile(file)
}

export const storeFile = (file: string, content: SecretFile) => {
  writeJsonFile(file, content)
}

export const getFileName = (file: string) => {
  return basename(file)
}
