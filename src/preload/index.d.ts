import type { NawiApi } from '@shared/types'

declare global {
  interface Window {
    api: NawiApi
  }
}

export {}
