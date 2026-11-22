import * as T from 'three';
import {lightInterior,finishSurfaces} from './interior.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
T.Mesh.prototype.raycast=acceleratedRaycast;
const $=id=>document.getElementById(id);
const places=[['Атриум','atrium','Центральный холл'],['Стеклянная галерея','gallery','Панорамный проход'],['Информационный центр','centre','Учебное пространство']];
for(const [name,img,desc] of places){
  const b=document.createElement('button');b.className='card';
  b.innerHTML='<img alt="" src="'+img+'.webp"><span><strong>'+name+'</strong><small>'+desc+'</small></span><span class="chev" aria-hidden="true">›</span>';
  b.onclick=()=>start(name);$('cards').append(b);
}
let renderer,camera,scene,views,pending,active=false,paused=false,selected,serial=0,drag=null;
let dirty=true;
let yaw=0,pitch=0,prev=0,frames=0,last=0;
const keys=new Set(),meshes=[],ray=new T.Raycaster(),origin=new T.Vector3(),dir=new T.Vector3(),down=new T.Vector3(0,-1,0);
ray.firstHitOnly=true;
const touch=matchMedia('(pointer:coarse)').matches;
let prefs={quality:'medium',fov:72,counter:false};
try{Object.assign(prefs,JSON.parse(localStorage.nisSettings||'{}'));}catch{}
function resize(){ dirty=true;
  const v=$('viewport');if(!renderer||!v.clientWidth)return;
  renderer.setSize(v.clientWidth,v.clientHeight,false);camera.aspect=v.clientWidth/v.clientHeight;camera.updateProjectionMatrix();
}
function apply(){
  $('angle').value=prefs.fov+'°';$('fps').hidden=!prefs.counter;
  if(renderer){renderer.setPixelRatio(({low:.65,medium:1,high:1.5})[prefs.quality]||1);camera.fov=Number(prefs.fov);resize();}
}
for(const id of ['quality','fov','counter']){
  const input=$(id);if(id==='counter')input.checked=prefs[id];else input.value=prefs[id];
  input.oninput=()=>{prefs[id]=id==='counter'?input.checked:input.value;apply();try{localStorage.nisSettings=JSON.stringify(prefs);}catch{}};
}
apply();window.addEventListener('resize',resize);
function panel(help){
  if(active)pause();$('panelTitle').textContent=help?'Управление':'Графика';$('options').hidden=help;$('instructions').hidden=!help;$('panel').showModal();
}
$('settings').onclick=()=>panel(false);$('help').onclick=()=>panel(true);$('close').onclick=()=>$('panel').close();
$('enter').onclick=()=>start('Атриум');
async function load(){
  if(!renderer){
    renderer=new T.WebGLRenderer({antialias:true,powerPreference:'high-performance'});$('viewport').append(renderer.domElement);
    scene=new T.Scene();scene.background=new T.Color(0xcbd9db);camera=new T.PerspectiveCamera(72,1,.045,350);camera.rotation.order='YXZ';
    lightInterior(renderer,scene);apply();
  }
  const [g,v]=await Promise.all([new GLTFLoader().loadAsync('school.glb',e=>{if(e.total)$('resume').textContent='Загрузка · '+Math.round(e.loaded*100/e.total)+'%';}),fetch('views.json').then(r=>r.json())]);
  await finishSurfaces(g.scene,renderer);views=v;scene.add(g.scene);g.scene.updateMatrixWorld(true);
  g.scene.traverse(m=>{if(m.isMesh){if(!m.geometry.boundsTree)computeBoundsTree.call(m.geometry);meshes.push(m);}});
}
function hit(p,d,far){ray.set(p,d);ray.far=far;return ray.intersectObjects(meshes,false)[0];}
const eye=1.57;
function look(){dirty=true;camera.rotation.set(pitch,yaw,0,'YXZ');}
function spawn(){
  const v=views.find(p=>p.name===selected)||views[0];camera.position.fromArray(v.position);
  const floor=hit(camera.position,down,2.5);if(floor&&floor.distance>1)camera.position.y=floor.point.y+eye;
  const [x,y,z]=v.direction;yaw=Math.atan2(-x,-z);pitch=Math.asin(y);look();
}
async function start(name){
  const seq=++serial;selected=name;$('place').textContent=name;$('home').hidden=true;$('tour').hidden=false;$('resume').hidden=false;$('resume').disabled=true;$('resume').textContent='Загрузка модели…';
  try{
    pending??=load().catch(e=>{pending=null;throw e;});await pending;if(seq!==serial)return;
    resize();spawn();active=true;paused=false;$('resume').hidden=true;$('resume').disabled=false;$('pad').hidden=!touch;prev=performance.now();renderer.setAnimationLoop(frame);
  }catch(e){if(seq!==serial)return;console.error(e);$('resume').disabled=false;$('resume').textContent='Не удалось открыть 3D · Повторить';}
}
$('leave').onclick=()=>{++serial;active=false;keys.clear();drag=null;if(document.pointerLockElement)document.exitPointerLock();renderer?.setAnimationLoop(null);$('tour').hidden=true;$('home').hidden=false;$('enter').focus();};
function pause(){paused=true;keys.clear();drag=null;if(document.pointerLockElement)document.exitPointerLock();$('resume').textContent='Продолжить прогулку';$('resume').hidden=false;}
$('reset').onclick=()=>{if(active)spawn();};
function lock(){if(!touch&&!document.pointerLockElement){try{renderer.domElement.requestPointerLock?.()?.catch(()=>{});}catch{}}}
$('resume').onclick=()=>{if(!active){start(selected);return;}paused=false;$('resume').hidden=true;lock();};
document.addEventListener('pointerlockchange',()=>{if(!document.pointerLockElement&&active)pause();});
function rotate(x,y){yaw-=x*.0023;pitch=T.MathUtils.clamp(pitch-y*.0023,-1.48,1.48);look();}
$('viewport').onpointerdown=e=>{if(!active||paused)return;drag=[e.clientX,e.clientY];e.target.setPointerCapture(e.pointerId);lock();};
$('viewport').onpointermove=e=>{if(drag&&!paused&&!document.pointerLockElement){rotate(e.clientX-drag[0],e.clientY-drag[1]);drag=[e.clientX,e.clientY];}};
$('viewport').onpointerup=$('viewport').onpointercancel=()=>drag=null;
document.onmousemove=e=>{if(active&&!paused&&document.pointerLockElement)rotate(e.movementX,e.movementY);};
window.addEventListener('keydown',e=>{if(!active||paused||$('panel').open)return;if(e.code==='Escape'){pause();return;}if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight'].includes(e.code)){e.preventDefault();keys.add(e.code);}});
window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>{if(active)pause();});
for(const b of $('pad').children){b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);keys.add(b.dataset.key);};b.onpointerup=b.onpointercancel=()=>keys.delete(b.dataset.key);}
function move(dx,dz){
  const p=camera.position,dist=Math.hypot(dx,dz);if(!dist)return;
  dir.set(dx/dist,0,dz/dist);
  for(const height of [-1,-.18]){origin.copy(p);origin.y+=height;if(hit(origin,dir,dist+.22))return;}
  origin.set(p.x+dx,p.y-eye+.39,p.z+dz);const floor=hit(origin,down,1.02);
  if(floor){p.set(origin.x,floor.point.y+eye,origin.z);dirty=true;}
}
function frame(time){
  const dt=Math.min((time-prev)/1000,.05);prev=time;
  if(!paused){
    const f=Number(keys.has('KeyW')||keys.has('ArrowUp'))-Number(keys.has('KeyS')||keys.has('ArrowDown'));
    const s=Number(keys.has('KeyD')||keys.has('ArrowRight'))-Number(keys.has('KeyA')||keys.has('ArrowLeft'));
    const step=(keys.has('ShiftLeft')||keys.has('ShiftRight')?4.5:2.6)*dt/(Math.hypot(f,s)||1);
    move((s*Math.cos(yaw)-f*Math.sin(yaw))*step,0);move(0,(-s*Math.sin(yaw)-f*Math.cos(yaw))*step);
  }
  if(dirty){renderer.render(scene,camera);dirty=false;}frames++;if(time-last>650){$('fps').textContent=Math.round(frames*1000/(time-last))+' FPS';last=time;frames=0;}
}


