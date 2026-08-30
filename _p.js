const { Client } = require('ssh2');
const run = (c, cmd) => new Promise((res) => c.exec(cmd, (e, s) => {
  if (e) return res(e.message);
  let b=''; s.on('data',d=>b+=d).stderr.on('data',d=>b+=d); s.on('close',()=>res(b.trim()));
}));
(async()=>{
  const c=new Client();
  await new Promise((r,j)=>{c.on('ready',r).on('error',j);
    c.connect({host:process.env.H,port:Number(process.env.PORT||22),username:process.env.U||'root',password:process.env.PW,readyTimeout:25000});});
  console.log(await run(c, process.env.C));
  c.end(); process.exit(0);
})().catch(e=>{console.log('出错:',e.message);process.exit(1)});
