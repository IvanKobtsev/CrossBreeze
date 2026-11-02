import type { FormattingOptions, TextEdit } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'

export interface SourceFormatOptions {
  tabWidth: number
  useTabs: boolean
  printWidth: number
  endOfLine: 'lf' | 'crlf'
}
export interface SourceFormatResult {
  text?: string | null
  diagnostics: { code: string; message: string }[]
}
export interface FormattingBinding {
  formatSource?: (source: string, options: SourceFormatOptions) => SourceFormatResult
}
export function formatOptions(options: FormattingOptions, settings?: Record<string, unknown>): SourceFormatOptions {
  const tabWidth = settings?.tabWidth ?? options.tabSize
  const useTabs = settings?.useTabs ?? !options.insertSpaces
  const printWidth = options['crossbreeze.printWidth'] ?? settings?.printWidth ?? 80
  const endOfLine = options['crossbreeze.endOfLine'] ?? settings?.endOfLine ?? 'lf'
  if (!Number.isInteger(tabWidth) || Number(tabWidth) < 1 || Number(tabWidth) > 16 ||
      typeof useTabs !== 'boolean' || !Number.isInteger(printWidth) || Number(printWidth) < 1 || Number(printWidth) > 1000 ||
      endOfLine !== 'lf' && endOfLine !== 'crlf') throw new Error('Invalid XCSS formatting options')
  return { tabWidth: Number(tabWidth), useTabs, printWidth: Number(printWidth), endOfLine }
}
export function formatEdits(source: string, result: SourceFormatResult): TextEdit[] {
  if (result.text == null) throw new Error(`XCSS formatting skipped: ${result.diagnostics[0]?.message ?? 'invalid syntax'}`)
  if (result.text === source) return []
  const document = TextDocument.create('file:///format.xcss', 'xcss', 0, source)
  return [{ range: { start: { line: 0, character: 0 }, end: document.positionAt(source.length) }, newText: result.text }]
}
