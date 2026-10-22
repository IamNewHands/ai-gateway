/**
 * 出站工具 schema 归一：让每个 object 型 schema 都显式声明 `required` 数组。
 *
 * 背景：`required` 在 JSON Schema 里是**可选**的，DSH 这类客户端给无参数工具只发
 * `{ type: 'object', properties: {} }`。严格的 OpenAI 兼容上游（实测 agentrouter 的
 * `/v1/chat/completions`）会把缺省的 `required` 重建成 `null`，随后整次请求被拒：
 *
 *   Invalid schema for function 'adhd_off': null is not of type "array"
 *
 * 而且它只报**第一个**违规工具（工具按字母序，`adhd_off` 恰好排第一），所以客户端侧
 * 逐个工具打补丁既改不完也看不出进度。补 `required: []` 语义完全等价（= 没有必填项），
 * 却能让这类上游通过，故在网关统一补一次，所有客户端一起受益。
 *
 * 只做**加法**：不删字段、不改 `strict`、不碰非 object 根（数组/联合根没有 `required` 语义）。
 */

/** 递归深度上限：`JSON.parse` 允许极深嵌套，避免恶意 body 把递归打成栈溢出。 */
const MAX_DEPTH = 32

/** 值为「schema 映射」（key → schema）的关键字。 */
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const

/** 值为「单个 schema」的关键字。 */
const SCHEMA_ONE_KEYS = [
  'items',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
] as const

/** 值为「schema 数组」的关键字。 */
const SCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function declaresObject(node: Record<string, unknown>): boolean {
  const type = node['type']
  if (typeof type === 'string') return type === 'object'
  if (Array.isArray(type)) return type.includes('object')
  // 没有 type 但带 properties 的写法在真实客户端里很常见，按 object 处理
  return node['properties'] !== undefined
}

/**
 * 原地补 `required`（递归）。
 *
 * `required` 存在但不是字符串数组时也一律改写为 `[]`：那已经是不合法 schema，
 * 上游同样会拒，改写成合法空数组比原样透传更有用。
 */
export function ensureRequiredArrays(node: unknown, depth = 0): void {
  if (!isPlainObject(node) || depth > MAX_DEPTH) return

  if (declaresObject(node)) {
    const required = node['required']
    const legal = Array.isArray(required) && required.every((key) => typeof key === 'string')
    if (!legal) node['required'] = []
  }

  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key]
    if (!isPlainObject(map)) continue
    for (const child of Object.values(map)) ensureRequiredArrays(child, depth + 1)
  }

  for (const key of SCHEMA_ONE_KEYS) {
    const child = node[key]
    if (Array.isArray(child)) {
      // items 的元组写法是 schema 数组
      for (const item of child) ensureRequiredArrays(item, depth + 1)
    } else if (isPlainObject(child)) {
      ensureRequiredArrays(child, depth + 1)
    }
  }

  for (const key of SCHEMA_LIST_KEYS) {
    const list = node[key]
    if (!Array.isArray(list)) continue
    for (const child of list) ensureRequiredArrays(child, depth + 1)
  }
}

/**
 * 单个函数定义（chat 形状 `{name, parameters}`）的归一。
 *
 * 缺 `parameters` 时补一个空对象 schema —— OpenAI 要求 function 必须带 `parameters`，
 * 缺了同样会被上游拒，补空表比留空更有用。
 */
function normalizeFunction(fn: Record<string, unknown>): void {
  const parameters = fn['parameters']
  if (parameters === undefined || parameters === null) {
    fn['parameters'] = { type: 'object', properties: {}, required: [] }
    return
  }
  ensureRequiredArrays(parameters)
}

/**
 * 归一一个 `body.tools[]` 元素，兼容三种在线形状：
 * - chat：`{ type: 'function', function: { name, parameters } }`
 * - responses：`{ type: 'function', name, parameters }`
 * - 少数自定义工具直接挂 `parameters`（如 custom/grammar 形状），原样递归
 */
function normalizeToolEntry(entry: unknown): void {
  if (!isPlainObject(entry)) return
  const fn = entry['function']
  if (isPlainObject(fn)) {
    normalizeFunction(fn)
    return
  }
  if (typeof entry['name'] === 'string') {
    normalizeFunction(entry)
    return
  }
  ensureRequiredArrays(entry['parameters'])
}

/**
 * 归一整份请求体里的工具 schema。
 *
 * 覆盖 `tools`（新形状）与 `functions`（OpenAI 旧形状）；无工具时**不新增任何字段**，
 * 因此对不带工具的请求（含图片、嵌入等）逐字节等价。
 */
export function normalizeToolSchemas(body: Record<string, unknown>): void {
  const tools = body['tools']
  if (Array.isArray(tools)) for (const entry of tools) normalizeToolEntry(entry)

  const functions = body['functions']
  if (Array.isArray(functions)) {
    for (const entry of functions) if (isPlainObject(entry)) normalizeFunction(entry)
  }
}
