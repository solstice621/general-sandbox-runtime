// Test-only RPC driver. Never installed or enabled by the production plugin.
// It calls the REAL registered ShellTool, real permissions, jobs and subprocesses.
export default {
  id: 'sandbox-runtime.acceptance-driver',
  async setup(ctx) {
    const calls = new Map()
    const controls = new Map()
    const any = {}
    await ctx.rpc.register({ id: 'sandbox-acceptance', events: {}, methods: {
      start: { input: any, output: any }, status: { input: any, output: any }, cancel: { input: any, output: any },
    } }, {
      async start(input) {
        const tool = (await ctx.tool.list()).find(x => x.id === 'shell')
        if (!tool) throw new Error('real ShellTool was not registered')
        if (calls.has(input.id)) throw new Error('duplicate test call')
        const controller = new AbortController()
        controls.set(input.id, controller)
        const progress = []
        calls.set(input.id, { status: 'running', progress })
        void tool.execute(input.args, {
          sessionID: input.sessionID, agent: input.agent ?? 'build',
          messageID: 'msg_sandbox_acceptance', id: input.id, signal: controller.signal,
          progress: async update => { progress.push(update) },
        }).then(result => calls.set(input.id, { status: 'completed', result, progress }),
          error => calls.set(input.id, { status: 'failed', error: String(error), progress }))
        return { id: input.id }
      },
      async status(input) { return calls.get(input.id) ?? { status: 'missing' } },
      async cancel(input) { controls.get(input.id)?.abort(); return { cancelled: true } },
    })
    return () => { for (const controller of controls.values()) controller.abort() }
  },
}
