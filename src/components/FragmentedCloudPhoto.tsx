import {useEffect,useRef} from "react";
import {listenWidgetMotion} from "../lib/bridge";
import {makeMistPatches,pushMist,stepMist,mistEnergy} from "../lib/mistVolume";

// Partition the existing image, without replacing its colors or texture.
export function FragmentedCloudPhoto({src,level}:{src:string;level:number}) {
  const imageRef=useRef<HTMLImageElement>(null),canvasRef=useRef<HTMLCanvasElement>(null),levelRef=useRef(level);
  levelRef.current=level;
  useEffect(()=>{
    const img=imageRef.current,canvas=canvasRef.current,c=canvas?.getContext('2d');if(!img||!canvas||!c)return;
    const patches=makeMistPatches(),reduced=matchMedia('(prefers-reduced-motion: reduce)'),size=160,sourceSize=256;
    canvas.width=canvas.height=size;const output=c.createImageData(size,size);
    const centerY=(.12+.455)/1.24;
    const blendAt=(x:number,y:number)=>{const t=Math.max(0,Math.min(1,(.19-Math.hypot(x-.5,y-centerY))/.08));return t*t*(3-2*t)};
    const complement=document.createElement('canvas');complement.width=complement.height=256;
    const maskContext=complement.getContext('2d');if(!maskContext)return;const maskPixels=maskContext.createImageData(256,256);
    for(let y=0;y<256;y++)for(let x=0;x<256;x++){
      const f=blendAt((x+.5)/256,(y+.5)/256),i=(y*256+x)*4;
      maskPixels.data[i]=maskPixels.data[i+1]=maskPixels.data[i+2]=255;
      // Compensate source-over alpha so the local blend never adds a bright disk.
      maskPixels.data[i+3]=Math.round(255*(1-f)/(1-.72*f));
    }
    maskContext.putImageData(maskPixels,0,0);const activeMask=`url(${complement.toDataURL()})`;
    let source:Uint8ClampedArray|null=null,dead=false,raf=0,previous=performance.now(),position:{x:number;y:number}|null=null,unlisten=()=>{};
    void img.decode().then(()=>{
      if(dead)return;const original=document.createElement('canvas');original.width=original.height=sourceSize;
      const context=original.getContext('2d')!;context.drawImage(img,0,0,sourceSize,sourceSize);source=context.getImageData(0,0,sourceSize,sourceSize).data;
    }).catch(()=>{});
    void listenWidgetMotion(p=>{if(position)pushMist(patches,p.x-position.x,p.y-position.y);position=p}).then(fn=>{if(dead)fn();else unlisten=fn});
    const sample=(x:number,y:number,k:number)=>{
      x=Math.max(0,Math.min(sourceSize-1.001,x));y=Math.max(0,Math.min(sourceSize-1.001,y));
      const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,i=(iy*sourceSize+ix)*4+k;
      return (source![i]*(1-fx)+source![i+4]*fx)*(1-fy)+(source![i+sourceSize*4]*(1-fx)+source![i+sourceSize*4+4]*fx)*fy;
    };
    const frame=(now:number)=>{
      stepMist(patches,(now-previous)/1000,!reduced.matches);previous=now;
      const active=mistEnergy(patches)>.006&&!reduced.matches&&!!source;
      if(active&&source){
        const q=Math.max(0,Math.min(1,levelRef.current/100)),meanX=patches.reduce((n,p)=>n+p.x,0)/patches.length,meanY=patches.reduce((n,p)=>n+p.y,0)/patches.length;
        const masks=patches.map(p=>{
          const dx=(p.x-meanX*.65)*.5/84.32,dy=(p.y-meanY)*.5/84.32;
          const cx=(.12+p.u)/1.24+dx,cy=(.12+1-q+.10+p.depth*q*.77)/1.24+dy;
          const rx=p.radiusX/1.24,ry=p.radiusY/1.24;
          const xs=Array.from({length:size},(_,x)=>Math.exp(-2.4*(((x+.5)/size-cx)/rx)**2));
          const ys=Array.from({length:size},(_,y)=>Math.exp(-2.4*(((y+.5)/size-cy)/ry)**2));
          return {dx,dy,xs,ys};
        });
        for(let y=0;y<size;y++)for(let x=0;x<size;x++){
          const nx=(x+.5)/size,ny=(y+.5)/size,i=(y*size+x)*4,edge=blendAt(nx,ny);
          if(edge===0){output.data[i+3]=0;continue;}
          let weight=0,red=0,green=0,blue=0,alpha=0;
          if(edge>0){for(const mask of masks){const w=mask.xs[x]*mask.ys[y];if(w<.00004)continue;const sx=(nx-mask.dx*edge)*sourceSize-.5,sy=(ny-mask.dy*edge)*sourceSize-.5;
            weight+=w;red+=sample(sx,sy,0)*w;green+=sample(sx,sy,1)*w;blue+=sample(sx,sy,2)*w;alpha+=sample(sx,sy,3)*w;}}
          if(weight>.00001){output.data[i]=red/weight;output.data[i+1]=green/weight;output.data[i+2]=blue/weight;output.data[i+3]=alpha/weight*.72*edge;}
          else {for(let k=0;k<3;k++)output.data[i+k]=sample(nx*sourceSize-.5,ny*sourceSize-.5,k);output.data[i+3]=sample(nx*sourceSize-.5,ny*sourceSize-.5,3)*.72*edge;}
        }
        c.putImageData(output,0,0);
      }
      // Settled rendering is the original DOM image, pixel-for-pixel.
      img.style.maskSize='100% 100%';img.style.maskRepeat='no-repeat';img.style.maskImage=active?activeMask:'';canvas.style.visibility=active?'visible':'hidden';

      raf=requestAnimationFrame(frame);
    };
    raf=requestAnimationFrame(frame);
    return()=>{dead=true;cancelAnimationFrame(raf);unlisten();img.style.maskImage=''};
  },[src]);
  return <><img ref={imageRef} className="orb-bubble-cloud" src={src} alt=""/><canvas ref={canvasRef} className="orb-bubble-cloud orb-cloud-fragments" aria-hidden="true" style={{visibility:'hidden',opacity:1}}/></>;
}
