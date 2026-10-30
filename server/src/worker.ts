import { parentPort } from 'node:worker_threads'
import { Project, type Aliases } from './project.js'
let project: Project
parentPort!.on('message', ({ id, method, args }) => {
  try {
    let result: unknown = null
    if (method === 'initialize') {
      project = new Project(args[0], args[1], message => parentPort!.postMessage({ warning: message }), args[2])
      project.initialize()
    } else if (method === 'update') project.update(args[0], args[1], args[2])
    else if (method === 'cssDiagnostics') result = project.cssDiagnostics(args[0], args[1])
    else if (method === 'close') project.close(args[0])
    else if (method === 'change') project.change(args[0])
    else if (method === 'configure') project.configure(args[0] as Aliases)
    else result = project.query(method, args[0], args[1], args[2])
    if (['initialize', 'update', 'close', 'change', 'configure'].includes(method)) parentPort!.postMessage({ watchPaths: project.watchPaths() })
    parentPort!.postMessage({ id, result })
  } catch (error) { parentPort!.postMessage({ id, error: String(error) }) }
})
