import { describe, expect, it } from 'vitest'
import { sourceLink } from '../src/renderer/src/c/source-link'

describe('explicit source-link previews', () => {
  it.each(['https://sources.example.com/article?q=public#section', 'https://docs.tavily.com/documentation/api-credits', 'https://api-docs.deepseek.com/guides/search/', 'https://例子.中国/资料'])('allows a complete public HTTPS source %s', value => {
    expect(sourceLink(value)).toEqual({ url: new URL(value).href })
  })
  it.each(['http://sources.example.com/article', 'http://localhost:3000/'])('retains a clear copy-only explanation for HTTP %s', value => {
    const result = sourceLink(value); expect(result.url).toBeUndefined(); expect(result.reason).toContain('HTTP')
  })
  it.each(['javascript:alert(1)', 'data:text/html,hello', 'file:///C:/private.txt', './notes.md', '//sources.example.com/article', 'https://user:password@sources.example.com/', 'https://sources.example.com:8443/', 'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/', 'https://8.8.8.8/', 'https://server/', 'https://server.local/', 'https://server.local./', 'https://server.internal/', 'https://server.test/', 'https://server.invalid/', 'https://sources.example.com/?api_key=private', 'https://sources.example.com/?X-Amz-Signature=private', 'https://sources.example.com/?sas=private', 'https://sources.example.com/\nprivate', 'https:\\sources.example.com\\private', '', undefined])('never exposes a directly navigable URL for %s', value => {
    const result = sourceLink(value); expect(result.url).toBeUndefined(); expect(result.reason).toBeTruthy()
  })
})
