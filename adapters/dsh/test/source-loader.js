// Test-only loader: executes the pinned upstream source without rewriting it or installing the DSH app.
import { registerHooks, createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = process.env.DSH_SOURCE_ROOT
if (!root) throw new Error('DSH_SOURCE_ROOT must name the extracted d743267388641bc76f17c45ce8b4c231aed1d32c checkout')
const lock = JSON.parse(readFileSync(new URL('../source-lock.json', import.meta.url), 'utf8'))
for (const [file, expected] of Object.entries(lock.files)) {
  const actual = createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
  if (actual !== expected) throw new Error(`pinned DSH source differs: ${file}`)
}
const packages = new Map()
// Optional test-only transpiler for the full registered-tool surface, whose
// original LLM barrel includes standard decorators unsupported by Node strip-types.
function verifyTestDependency(name, file) {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== lock.testDependencies[name].entrySHA256) throw new Error(`test dependency differs: ${name}`)
}
if (process.env.DSH_TYPESCRIPT_LIB) verifyTestDependency('typescript', process.env.DSH_TYPESCRIPT_LIB)
if (process.env.DSH_ZOD_ROOT) verifyTestDependency('zod', join(process.env.DSH_ZOD_ROOT, 'index.js'))
const typescript = process.env.DSH_TYPESCRIPT_LIB ? createRequire(import.meta.url)(process.env.DSH_TYPESCRIPT_LIB) : undefined
for (const folder of ['packages', 'vendor']) {
  for (const entry of readdirSync(join(root, folder), { recursive: true })) {
    if (!entry.endsWith('package.json')) continue
    const file = join(root, folder, entry)
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    if (pkg.name) packages.set(pkg.name, { pkg, dir: dirname(file) })
  }
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod' && process.env.DSH_ZOD_ROOT) return { url: pathToFileURL(join(process.env.DSH_ZOD_ROOT, 'index.js')).href, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) {
      const [namespace, name, ...rest] = specifier.split('/')
      const found = packages.get(`${namespace}/${name}`)
      if (found) {
        let file
        // The sandbox imports only HarnessError from the LLM barrel. Use its
        // unchanged defining module to avoid loading unrelated LLM decorators.
        if (!rest.length) file = join(found.dir, !typescript && specifier === '@deepseek-ai/dsh-llm' ? 'src/error.ts' : 'src/index.ts')
        else if (rest[0] === 'src' || rest.join('/') === 'package.json') file = join(found.dir, ...rest)
        else {
          const exp = found.pkg.exports?.[`./${rest.join('/')}`]
          const target = typeof exp === 'string' ? exp : exp?.default ?? exp?.import
          file = target && join(found.dir, target.replace(/^\.\/lib\//, 'src/').replace(/\.(?:js|mjs|cjs)$/, '.ts'))
        }
        if (!file || !existsSync(file)) throw new Error(`no pinned source entry for ${specifier}`)
        return { url: pathToFileURL(resolve(file)).href, shortCircuit: true }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (typescript && url.startsWith('file:') && url.endsWith('.ts')) {
      const fileName = fileURLToPath(url)
      const source = readFileSync(fileName, 'utf8')
      const compiled = typescript.transpileModule(source, { fileName, compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.ESNext, useDefineForClassFields: true } })
      return { source: compiled.outputText, format: 'module', shortCircuit: true }
    }
    return next(url, context)
  },
})
