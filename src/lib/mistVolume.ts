export interface MistPatch {
  id: number; u: number; depth: number; radiusX: number; radiusY: number;
  phase: number; speed: number; stiffness: number; damping: number; gain: number;
  x: number; y: number; vx: number; vy: number;
}
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export function makeMistPatches(): MistPatch[] {
  return Array.from({length:24},(_,id)=>{
    const row=Math.floor(id/8),col=id%8;
    return {id,u:(col-.3)/6.4,depth:row/2,radiusX:.21+(id%3)*.025,radiusY:.18+row*.075,
      phase:id*2.39996,speed:.38+(id%5)*.075,stiffness:24+(id%6)*4.4,damping:6+(id%4)*.7,gain:.7+(id%5)*.18,
      x:0,y:0,vx:0,vy:0};
  });
}
export function pushMist(patches:MistPatch[],dx:number,dy:number) {
  const horizontal=clamp(dx,-35,35),vertical=clamp(dy,-35,35);
  for(const p of patches){
    p.vx=clamp(p.vx-horizontal*4.8*p.gain,-90,90);
    p.vy=clamp(p.vy+horizontal*(p.u-.5)*7*p.gain-vertical*2.6*p.gain
      +Math.abs(horizontal)*Math.sin(p.phase)*1.8,-75,75);
  }
}
export function stepMist(patches:MistPatch[],elapsed:number,animate=true) {
  const dt=clamp(elapsed,0,.034);
  for(const p of patches){
    if(!animate){p.x=p.y=p.vx=p.vy=0;continue;}
    p.vx+=(-p.stiffness*p.x-p.damping*p.vx)*dt;
    p.vy+=(-(p.stiffness*1.12)*p.y-(p.damping*.92)*p.vy)*dt;
    p.x=clamp(p.x+p.vx*dt,-12,12);p.y=clamp(p.y+p.vy*dt,-10,10);
  }
}
export function mistEnergy(patches:MistPatch[]) {
  return Math.min(1,patches.reduce((n,p)=>n+Math.abs(p.x)*.09+Math.abs(p.y)*.1+Math.abs(p.vx)*.008+Math.abs(p.vy)*.008,0)/patches.length);
}
