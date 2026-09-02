import { describe, it, expect } from 'vitest'
import { cosySessionFor, cosyHeaders, buildBearer } from './cosy'
import { md5Hex } from './md5'

describe('COSY 对齐 keirouter（身份字段/指纹常量/头集）', () => {
  it('Authorization 头是 Bearer COSY.<payloadB64>.<sig> 结构', async () => {
    const sess = await cosySessionFor('dt-test123', 'drt-test', 'uid-1001', '张三')
    const headers = cosyHeaders(sess, 'encoded-body', 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1', 'text/event-stream', true)
    expect(headers['Authorization']).toMatch(/^Bearer COSY\.\S+\.[0-9a-f]{32}$/)
  })

  it('cosyVersion 为 1.0.0（对齐 keirouter IDEVersion）', async () => {
    const sess = await cosySessionFor('dt-test1', 'drt', 'u1', 'n')
    const headers = cosyHeaders(sess, '{}', 'https://api3.qoder.sh/algo/api/v2/model/list', 'application/json', false)
    expect(headers['Cosy-Version']).toBe('1.0.0')
  })

  it('指纹常量对齐 keirouter：data-policy=disagree、clienttype=5、machineos=x86_64_windows、login-version=v2、clientip=127.0.0.1', async () => {
    const sess = await cosySessionFor('dt-test1', 'drt', 'u1', 'n')
    const headers = cosyHeaders(sess, '{}', 'https://api3.qoder.sh/algo/api/v2/model/list', 'application/json', false)
    expect(headers['Cosy-Data-Policy']).toBe('disagree')
    expect(headers['Cosy-Clienttype']).toBe('5')
    expect(headers['Cosy-Machineos']).toBe('x86_64_windows')
    expect(headers['Login-Version']).toBe('v2')
    expect(headers['Cosy-Clientip']).toBe('127.0.0.1')
  })

  it('补齐了 Cosy-Bodyhash / Cosy-Bodylength / Cosy-Sigpath / X-Request-Id / 空的组织头', async () => {
    const sess = await cosySessionFor('dt-test1', 'drt', 'u1', 'n')
    const body = 'encoded-body'
    const url = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1'
    const headers = cosyHeaders(sess, body, url, 'text/event-stream', true)
    expect(headers['Cosy-Bodylength']).toBe(String(body.length))
    expect(headers['Cosy-Bodyhash']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers['Cosy-Sigpath']).toBe('/api/v2/service/pro/sse/agent_chat_generation')
    expect(headers['X-Request-Id']).toBeTruthy()
    expect(headers['Cosy-Organization-Id']).toBe('')
    expect(headers['Cosy-Organization-Tags']).toBe('')
  })

  it('Cosy-Machinetoken 与 Cosy-Machineid 同值（对齐 keirouter MachineID 复用）', async () => {
    const sess = await cosySessionFor('dt-test1', 'drt', 'u1', 'n')
    const headers = cosyHeaders(sess, '{}', 'https://api3.qoder.sh/algo/api/v2/model/list', 'application/json', false)
    expect(headers['Cosy-Machinetoken']).toBe(headers['Cosy-Machineid'])
  })

  it('签名 sig 等于 sigInput 的 MD5，sigInput 结构=payloadB64\\ncosyKey\\ndate\\nbody\\nsigPath', async () => {
    const sess = await cosySessionFor('dt-test1', 'drt', 'u1', 'n')
    const body = 'xyz-body'
    const rawUrl = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1'
    const b = buildBearer(sess, body, rawUrl)
    expect(b.sigInput).toBe(`${b.payloadB64}\n${sess.cosyKey}\n${b.date}\n${body}\n/api/v2/service/pro/sse/agent_chat_generation`)
    expect(b.bearer).toBe(`Bearer COSY.${b.payloadB64}.${md5Hex(b.sigInput)}`)
  })
})