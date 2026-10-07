"""Wedge assemblies onto the fixed X-Lock: step (A) the left one, step (B) the right one.
Requires Playwright and a served URL."""
import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader']);page=b.new_page(viewport={'width':1280,'height':850});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8144/?practice=1');page.wait_for_function('window.KBParts&&KBParts.ready()')
 page.evaluate('''()=>{
 window.fixture=(rightOffset=0,missing=false)=>{
 KBAnswer.hide();let ps=KBParts.answer().parts.filter(d=>d.step<=3 && (!missing||d.step!==1));
 KB.loadSceneData({objects:ps.map(d=>{let t=KBParts.nodeTransform(d.key,d.path[d.path.length-1]);return {id:d.id,type:'part:'+d.key,name:d.name,p:t.p,r:t.r,s:[1,1,1]}})},true);
 let base=KB.objectsRoot.children.find(n=>n.userData.kbType==='part:aluminum_x_lock');let offset=KBWorkspace.destination(base).sub(base.position);
 KB.objectsRoot.children.forEach(n=>{n.position.add(offset);if(n.name.includes('Right'))n.position.x+=rightOffset;n.updateMatrixWorld(true)});
 KB.resetHistory();window.base=base;
 };
 }''')
 a=page.evaluate('''()=>{let s=KBParts.answer().steps;return [s[2],s[3]].map(x=>({name:x.name,requires:x.requires,base:x.assembly&&x.assembly.base,groups:x.assembly&&x.assembly.groups.length}))}''');print(a)
 assert a[0]['requires']==[0] and a[1]['requires']==[1] and a[0]['groups']==1 and a[1]['groups']==1 and a[0]['base']==a[1]['base'],a
 for offset,missing in [(0,True),(2,False),(0,False)]:
  r=page.evaluate('''([off,missing])=>{fixture(off,missing);let res=KBCheck.evaluate();return {A:res.steps[2].state,B:res.steps[3].state,totalA:res.steps[2].total,totalB:res.steps[3].total,rear:res.steps[4].state}}''',[offset,missing]);print(offset,missing,r)
  assert r['A']=='complete',r
  assert (r['B']=='complete')==(offset==0 and not missing),r
  if offset or missing:assert r['rear']=='blocked',r
 page.evaluate('fixture(2);KBAnswer.showStep(3)')
 assert 'X-Lock (B)' in page.locator('#nextGuide h2').inner_text()
 assert 'Right Arm Wedge' in page.locator('.ng-parts').inner_text()
 # Inspect ghost meshes by shared geometry: (B) shows no X-Lock ghost, the X-Lock is already in place.
 r=page.evaluate('''()=>{let baseGeos=KBParts.prims('aluminum_x_lock').map(p=>p.geometry);let ghosts=[];KB.scene.children.filter(n=>n.userData.kbOverlay).forEach(n=>n.traverse(m=>{if(m.isMesh&&baseGeos.includes(m.geometry))ghosts.push(m)}));return {ghosts:ghosts.length,focus:KBAnswer.focus()}}''');assert r['ghosts']==0,r
 # Right group near its spot: correction keeps the receiving X-Lock stationary and passes (B).
 r=page.evaluate('''()=>{fixture(.07);let before=base.matrixWorld.clone();KB.pushSnapshot();base.updateWorldMatrix(true,false);let s=KBCheck.evaluate().steps[3];return {state:s.state,ok:s.ok,roots:KB.objectsRoot.children.length,baseDrift:Math.max(...before.elements.map((x,i)=>Math.abs(x-base.matrixWorld.elements[i])))}}''');print('correct',r);assert r['state']=='complete' and r['roots']==1 and r['baseDrift']<1e-8,r
 assert not errors,errors
 b.close();print('PASS (A) left only, (B) right only, rear blocked, fixed base/no base ghost, side checklist, correction and grouping')
