import { describe, it, expect } from 'vitest'
import { formatTablesForChat, stripMarkdownInline, formatTablesForWhatsApp, formatTablesForSlack } from './table-formatter.js'

describe('formatTablesForChat', () => {
  it('passes through text with no table unchanged', () => {
    const input = 'Hello world\nNo table here.'
    expect(formatTablesForChat(input)).toBe(input)
  })

  it('converts a simple 2-column table with header + 2 rows', () => {
    const input = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '| Bob | 25 |',
    ].join('\n')

    const result = formatTablesForChat(input)

    // Must be wrapped in triple backticks
    expect(result.startsWith('```')).toBe(true)
    expect(result.endsWith('```')).toBe(true)

    // Top border
    expect(result).toContain('╔')
    expect(result).toContain('╗')

    // Header separator
    expect(result).toContain('╠')
    expect(result).toContain('╣')

    // Bottom border
    expect(result).toContain('╚')
    expect(result).toContain('╝')

    // Column separators
    expect(result).toContain('╦')
    expect(result).toContain('╬')
    expect(result).toContain('╩')

    // Cell walls
    expect(result).toContain('║')

    // Header content
    expect(result).toContain('Name')
    expect(result).toContain('Age')

    // Data content
    expect(result).toContain('Alice')
    expect(result).toContain('Bob')
    expect(result).toContain('30')
    expect(result).toContain('25')

    // Separator row dashes must NOT appear as data
    expect(result).not.toMatch(/\| ?-+ ?\|/)
  })

  it('preserves text before and after the table', () => {
    const input = [
      'Here is a table:',
      '| Col1 | Col2 |',
      '| ---- | ---- |',
      '| A | B |',
      'End of table.',
    ].join('\n')

    const result = formatTablesForChat(input)
    expect(result).toMatch(/^Here is a table:/)
    expect(result).toMatch(/End of table\.$/)
    expect(result).toContain('╔')
    expect(result).toContain('A')
    expect(result).toContain('B')
  })

  it('converts multiple tables in one message', () => {
    const input = [
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      'Some text between tables.',
      '',
      '| X | Y | Z |',
      '| - | - | - |',
      '| p | q | r |',
    ].join('\n')

    const result = formatTablesForChat(input)
    // Count occurrences of top-left corner = 2 tables
    const topLeftCount = (result.match(/╔/g) || []).length
    expect(topLeftCount).toBe(2)
    expect(result).toContain('Some text between tables.')
    expect(result).toContain('p')
    expect(result).toContain('q')
    expect(result).toContain('r')
  })

  it('sizes columns to widest cell (short header, long data cell)', () => {
    const input = [
      '| A | B |',
      '| - | - |',
      '| short | a very long value |',
    ].join('\n')

    const result = formatTablesForChat(input)
    // The second column should accommodate "a very long value"
    expect(result).toContain('a very long value')
    // All rows in a column must have the same width — check borders are aligned
    const lines = result.split('\n').filter(l => l.startsWith('║') || l.startsWith('╔') || l.startsWith('╠') || l.startsWith('╟') || l.startsWith('╚'))
    const lengths = lines.map(l => l.length)
    // All non-empty structural lines must have the same length
    const unique = [...new Set(lengths)]
    expect(unique).toHaveLength(1)
  })

  it('handles a single-column table', () => {
    const input = [
      '| Item |',
      '| ---- |',
      '| Apple |',
      '| Banana |',
    ].join('\n')

    const result = formatTablesForChat(input)
    expect(result).toContain('╔')
    expect(result).toContain('╗')
    expect(result).toContain('Apple')
    expect(result).toContain('Banana')
    // No column joining chars since single column
    expect(result).not.toContain('╦')
    expect(result).not.toContain('╬')
  })

  it('pads empty cells with spaces to column width', () => {
    const input = [
      '| Name | Value |',
      '| ---- | ----- |',
      '| Foo |  |',
      '| Bar | baz |',
    ].join('\n')

    const result = formatTablesForChat(input)
    // All structural lines must have same length
    const lines = result.split('\n').filter(l => l.startsWith('║') || l.startsWith('╔') || l.startsWith('╚') || l.startsWith('╠') || l.startsWith('╟'))
    const lengths = lines.map(l => l.length)
    const unique = [...new Set(lengths)]
    expect(unique).toHaveLength(1)
    // Content is preserved
    expect(result).toContain('Foo')
    expect(result).toContain('baz')
  })

  it('includes row separators between data rows using thin box chars', () => {
    const input = [
      '| X | Y |',
      '| - | - |',
      '| 1 | 2 |',
      '| 3 | 4 |',
    ].join('\n')

    const result = formatTablesForChat(input)
    // Row separator characters
    expect(result).toContain('╟')
    expect(result).toContain('╢')
    expect(result).toContain('╫')
  })

  it('strips markdown from cell content', () => {
    const input = [
      '| **Name** | Age |',
      '| --- | --- |',
      '| ~~Alice~~ | 30 |',
    ].join('\n')

    const result = formatTablesForChat(input)
    expect(result).toContain('Name')
    expect(result).not.toContain('**Name**')
    expect(result).toContain('Alice')
    expect(result).not.toContain('~~Alice~~')
  })
})

describe('stripMarkdownInline', () => {
  it('strips bold markers **', () => {
    expect(stripMarkdownInline('**bold** and more')).toBe('bold and more')
  })

  it('strips bold and strikethrough together', () => {
    expect(stripMarkdownInline('**bold** and ~~strike~~')).toBe('bold and strike')
  })

  it('strips underline __ markers', () => {
    expect(stripMarkdownInline('__underline__ and `code`')).toBe('underline and code')
  })

  it('strips backtick code spans', () => {
    expect(stripMarkdownInline('`code` here')).toBe('code here')
  })

  it('passes through normal text unchanged', () => {
    expect(stripMarkdownInline('normal text')).toBe('normal text')
  })

  it('does not strip single asterisk (Slack italic)', () => {
    expect(stripMarkdownInline('*italic* text')).toBe('*italic* text')
  })

  it('does not strip single underscore', () => {
    expect(stripMarkdownInline('_italic_ text')).toBe('_italic_ text')
  })
})

describe('formatTablesForWhatsApp', () => {
  it('uses ASCII box chars (+, -, |, =) not Unicode box-drawing', () => {
    const input = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
    ].join('\n')

    const result = formatTablesForWhatsApp(input)
    expect(result).toContain('+')
    expect(result).toContain('-')
    expect(result).toContain('|')
    expect(result).toContain('=')
    // No Unicode box drawing chars
    expect(result).not.toContain('╔')
    expect(result).not.toContain('║')
    expect(result).not.toContain('╠')
    expect(result).not.toContain('╚')
  })

  it('top border uses + and -', () => {
    const input = [
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n')

    const result = formatTablesForWhatsApp(input)
    const lines = result.split('\n')
    // First line after opening ``` is the top border
    const topLine = lines[1]
    expect(topLine).toMatch(/^\+[-+]+\+$/)
  })

  it('header separator uses + and =', () => {
    const input = [
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n')

    const result = formatTablesForWhatsApp(input)
    expect(result).toMatch(/\+[=+]+\+/)
  })

  it('strips markdown from cell content', () => {
    const input = [
      '| **Name** | Value |',
      '| --- | --- |',
      '| ~~Alice~~ | 30 |',
    ].join('\n')

    const result = formatTablesForWhatsApp(input)
    expect(result).toContain('Name')
    expect(result).not.toContain('**Name**')
    expect(result).toContain('Alice')
    expect(result).not.toContain('~~Alice~~')
  })

  it('wraps output in triple backticks', () => {
    const input = [
      '| X | Y |',
      '| - | - |',
      '| a | b |',
    ].join('\n')

    const result = formatTablesForWhatsApp(input)
    expect(result.startsWith('```')).toBe(true)
    expect(result.endsWith('```')).toBe(true)
  })

  it('passes through non-table text unchanged', () => {
    const input = 'No table here.'
    expect(formatTablesForWhatsApp(input)).toBe(input)
  })
})

describe('formatTablesForSlack', () => {
  it('returns blocks for a 2-column table', () => {
    const input = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '| Bob | 25 |',
    ].join('\n')

    const result = formatTablesForSlack(input)
    expect(result.blocks).toBeDefined()
    expect(result.blocks!.length).toBeGreaterThan(0)
    // Should have section blocks with fields
    const sectionBlocks = result.blocks!.filter(b => b.type === 'section' && b.fields)
    expect(sectionBlocks.length).toBeGreaterThan(0)
  })

  it('2-col table: first section block has header fields', () => {
    const input = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
    ].join('\n')

    const result = formatTablesForSlack(input)
    expect(result.blocks).toBeDefined()
    const firstSection = result.blocks![0]
    expect(firstSection?.type).toBe('section')
    expect(firstSection?.fields).toBeDefined()
    expect(firstSection?.fields![0]?.text).toContain('Name')
    expect(firstSection?.fields![1]?.text).toContain('Age')
  })

  it('2-col table: preserves markdown in cell content (not stripped)', () => {
    const input = [
      '| **Name** | Age |',
      '| --- | --- |',
      '| *Alice* | 30 |',
    ].join('\n')

    const result = formatTablesForSlack(input)
    expect(result.blocks).toBeDefined()
    // Markdown should be preserved in blocks (Slack renders mrkdwn natively)
    const allFieldText = result.blocks!
      .filter(b => b.fields)
      .flatMap(b => b.fields!.map(f => f.text))
      .join(' ')
    expect(allFieldText).toContain('**Name**')
  })

  it('2-col table: text fallback is plain (unicode code block)', () => {
    const input = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
    ].join('\n')

    const result = formatTablesForSlack(input)
    expect(result.text).toContain('╔')
    expect(result.text).toContain('Alice')
  })

  it('3-column table returns no blocks, just text with code block', () => {
    const input = [
      '| A | B | C |',
      '| - | - | - |',
      '| 1 | 2 | 3 |',
    ].join('\n')

    const result = formatTablesForSlack(input)
    expect(result.blocks).toBeUndefined()
    expect(result.text).toContain('╔')
    expect(result.text).toContain('1')
    expect(result.text).toContain('2')
    expect(result.text).toContain('3')
  })

  it('non-table text has no blocks', () => {
    const input = 'Just plain text here.'
    const result = formatTablesForSlack(input)
    expect(result.blocks).toBeUndefined()
    expect(result.text).toBe(input)
  })

  it('mixed content: text before and after 2-col table appears in blocks and fallback', () => {
    const input = [
      'Before table.',
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      'After table.',
    ].join('\n')

    const result = formatTablesForSlack(input)
    expect(result.blocks).toBeDefined()
    // Text segments appear in block list
    const textBlocks = result.blocks!.filter(b => b.type === 'section' && b.text && !b.fields)
    expect(textBlocks.some(b => b.text?.text?.includes('Before table.'))).toBe(true)
    expect(textBlocks.some(b => b.text?.text?.includes('After table.'))).toBe(true)
    // Fallback text contains everything
    expect(result.text).toContain('Before table.')
    expect(result.text).toContain('After table.')
    expect(result.text).toContain('Alice')
  })
})
