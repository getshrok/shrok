import { describe, it, expect } from 'vitest'
import { markdownToTelegramHtml } from './html.js'

describe('markdownToTelegramHtml', () => {
  it('converts bold', () => {
    expect(markdownToTelegramHtml('**hello**')).toBe('<b>hello</b>')
  })

  it('converts strikethrough', () => {
    expect(markdownToTelegramHtml('~~deleted~~')).toBe('<s>deleted</s>')
  })

  it('converts links', () => {
    expect(markdownToTelegramHtml('[click](https://example.com)')).toBe('<a href="https://example.com">click</a>')
  })

  it('converts headers to bold', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>')
    expect(markdownToTelegramHtml('## Sub')).toBe('<b>Sub</b>')
  })

  it('converts inline code', () => {
    expect(markdownToTelegramHtml('use `foo` here')).toBe('use <code>foo</code> here')
  })

  it('converts code blocks to pre', () => {
    expect(markdownToTelegramHtml('```\nsome code\n```')).toBe('<pre>some code</pre>')
  })

  it('escapes HTML in body text', () => {
    expect(markdownToTelegramHtml('1 < 2 & 3 > 0')).toBe('1 &lt; 2 &amp; 3 &gt; 0')
  })

  it('escapes HTML inside code blocks', () => {
    expect(markdownToTelegramHtml('```\n<div>hi</div>\n```')).toBe('<pre>&lt;div&gt;hi&lt;/div&gt;</pre>')
  })

  it('preserves code blocks from markdown conversion', () => {
    expect(markdownToTelegramHtml('```\n**not bold**\n```')).toBe('<pre>**not bold**</pre>')
  })

  it('handles mixed content', () => {
    const input = '**NVIDIA** is at $200. See [details](https://x.com) for more.\n\n~~old~~'
    const expected = '<b>NVIDIA</b> is at $200. See <a href="https://x.com">details</a> for more.\n\n<s>old</s>'
    expect(markdownToTelegramHtml(input)).toBe(expected)
  })

  it('passes through plain text with escaping', () => {
    expect(markdownToTelegramHtml('just text')).toBe('just text')
  })
})
