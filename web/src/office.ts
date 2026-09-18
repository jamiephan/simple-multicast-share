export const wordExtensions = new Set(['docx', 'docm'])
export const spreadsheetExtensions = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods'])
export const presentationExtensions = new Set(['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'])
export const legacyOfficeExtensions = new Set(['doc', 'ppt'])

export function officeKind(extension: string) {
  if (wordExtensions.has(extension)) return 'word'
  if (spreadsheetExtensions.has(extension)) return 'spreadsheet'
  if (presentationExtensions.has(extension)) return 'presentation'
  if (legacyOfficeExtensions.has(extension)) return 'legacy'
  return null
}
