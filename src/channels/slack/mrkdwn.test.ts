import { describe, it, expect } from 'vitest'
import { markdownToMrkdwn } from './mrkdwn.js'

describe('markdownToMrkdwn', () => {
  it('converts bold', () => {
    expect(markdownToMrkdwn('**hello**')).toBe('*hello*')
  })

  it('converts strikethrough', () => {
    expect(markdownToMrkdwn('~~deleted~~')).toBe('~deleted~')
  })

  it('converts links', () => {
    expect(markdownToMrkdwn('[click here](https://example.com)')).toBe('<https://example.com|click here>')
  })

  it('converts headers to bold', () => {
    expect(markdownToMrkdwn('# Title')).toBe('*Title*')
    expect(markdownToMrkdwn('## Subtitle')).toBe('*Subtitle*')
    expect(markdownToMrkdwn('### Deep')).toBe('*Deep*')
  })

  it('preserves inline code', () => {
    expect(markdownToMrkdwn('use `**not bold**` here')).toBe('use `**not bold**` here')
  })

  it('preserves code blocks', () => {
    const input = '```\n**not bold**\n~~not strike~~\n```'
    expect(markdownToMrkdwn(input)).toBe(input)
  })

  it('handles mixed content', () => {
    const input = '**NVIDIA** is at $200. See [details](https://finance.com) for more.\n\n~~old price~~'
    const expected = '*NVIDIA* is at $200. See <https://finance.com|details> for more.\n\n~old price~'
    expect(markdownToMrkdwn(input)).toBe(expected)
  })

  it('passes through plain text unchanged', () => {
    expect(markdownToMrkdwn('just some text')).toBe('just some text')
  })

  it('handles bold inside a line with other content', () => {
    expect(markdownToMrkdwn('The **price** is $200')).toBe('The *price* is $200')
  })
})
