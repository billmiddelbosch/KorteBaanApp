// Positioned text of a pdf: the ritverloop and uitslag pdf's are tables without structure, so
// parsers work on the x/y position of every text item.
import { getDocumentProxy } from 'unpdf'

export interface PdfItem {
  x: number
  y: number
  s: string
}

export interface PdfLine {
  page: number
  y: number
  items: PdfItem[] // left to right
}

export const lineText = (line: PdfLine) => line.items.map((i) => i.s).join(' ')

// Groups items into lines (same y within ±2), top to bottom per page
export function toLines(pages: PdfItem[][]): PdfLine[] {
  const lines: PdfLine[] = []
  pages.forEach((items, index) => {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
    const pageLines: PdfLine[] = []
    for (const item of sorted) {
      const line = pageLines.find((l) => Math.abs(l.y - item.y) <= 2)
      if (line) line.items.push(item)
      else pageLines.push({ page: index + 1, y: item.y, items: [item] })
    }
    for (const line of pageLines) line.items.sort((a, b) => a.x - b.x)
    lines.push(...pageLines)
  })
  return lines
}

export async function pdfLines(data: Uint8Array): Promise<PdfLine[]> {
  // verbosity 0: no "TT: undefined function" font warnings in the logs
  const pdf = await getDocumentProxy(data, { verbosity: 0 })
  const pages: PdfItem[][] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent()
    const items: PdfItem[] = []
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      items.push({ x: Math.round(item.transform[4]), y: Math.round(item.transform[5]), s: item.str.trim() })
    }
    pages.push(items)
  }
  return toLines(pages)
}
