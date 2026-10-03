import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
const root=process.cwd(), types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}
createServer(async(req,res)=>{try{const path=normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/,''),file=await readFile(join(root,path==='/'?'index.html':path));res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream'});res.end(file)}catch{res.writeHead(404);res.end('Not found')}}).listen(4173,()=>console.log('MOKA dashboard: http://localhost:4173'))
