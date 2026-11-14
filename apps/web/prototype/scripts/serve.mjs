import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const script=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../server/server.py');
const child=spawn(process.env.GROWWHERE_PYTHON || 'python',[script],{stdio:'inherit',env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
child.on('error',error=>{console.error(`Не вдалося запустити Python API: ${error.message}`);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code || 0;});
process.on('SIGINT',()=>child.kill('SIGINT'));
process.on('SIGTERM',()=>child.kill('SIGTERM'));
