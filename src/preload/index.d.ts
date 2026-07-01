import type { LicenseApi, PdfApi } from './index'

declare global {
  interface Window {
    pdf: PdfApi
    license: LicenseApi
  }
}

export {}
