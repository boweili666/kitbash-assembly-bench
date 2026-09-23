"""Both wedge assemblies onto fixed X-Lock; requires Playwright and a served URL."""
import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader']);page=b.new_page(viewport={'width':1280,'height':850});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8144/?practice=1');page.wait_for_function('window.KBParts&&KBParts.ready()')
 page.evaluate('''()=>{
 window.fixture=(rightOffset=0,missing=false)=>{
 KBAnswer.hide();let ps=KBParts.answer().parts.filter(d=>d.step<=2 && (!missing||d.step!==1));
 KB.loadSceneData({objects:ps.map(d=>{let t=KBParts.nodeTransform(d.key,d.path[d.path.length-1]);return {id:d.id,type:'part:'+d.key,name:d.name,p:t.p,r:t.r,s:[1,1,1]}})},true);
 let base=KB.objectsRoot.children.find(n=>n.userData.kbType==='part:aluminum_x_lock');let offset=KBWorkspace.destination(base).sub(base.position);
 KB.objectsRoot.children.forEach(n=>{n.position.add(offset);if(n.name.includes('Right'))n.position.x+=rightOffset;n.updateMatrixWorld(true)});
 KB.resetHistory();window.base=base;
 };
 }''')
 for offset,missing in [(0,True),(2,False),(0,False)]:
  r=page.evaluate('''([off,missing])=>{fixture(off,missing);let res=KBCheck.evaluate();return {state:res.steps[2].state,ok:res.steps[2].ok,total:res.steps[2].total,requires:res.steps[2].requires,rear:res.steps[3].state}}''',[offset,missing]);print(offset,missing,r)
  assert r['total']==4 and r['requires']==[0,1]
  assert (r['state']=='complete')==(offset==0 and not missing),r
  if offset or missing:assert r['rear']=='blocked'
 page.evaluate('fixture(2);KBAnswer.showStep(2)')
 assert 'both Wedge' in page.locator('#nextGuide h2').inner_text()
 assert 'Right Arm Wedge' in page.locator('.ng-parts').inner_text()
 # Inspect ghost meshes by shared geometry: no X-Lock ghost; both right members move together.
 r=page.evaluate('''()=>{let baseGeos=KBParts.prims('aluminum_x_lock').map(p=>p.geometry);let ghosts=[];KB.scene.children.filter(n=>n.userData.kbOverlay).forEach(n=>n.traverse(m=>{if(m.isMesh&&baseGeos.includes(m.geometry))ghosts.push(m)}));return {ghosts:ghosts.length,focus:KBAnswer.focus()}}''');assert r['ghosts']==0,r
 # Near both sides: correction keeps receiving X-Lock stationary and passes the operation.
 r=page.evaluate('''()=>{fixture(.07);let before=base.matrixWorld.clone();KB.pushSnapshot();base.updateWorldMatrix(true,false);let s=KBCheck.evaluate().steps[2];return {state:s.state,ok:s.ok,roots:KB.objectsRoot.children.length,baseDrift:Math.max(...before.elements.map((x,i)=>Math.abs(x-base.matrixWorld.elements[i])))}}''');print('correct',r);assert r['state']=='complete' and r['roots']==1 and r['baseDrift']<1e-8,r
 assert not errors,errors
 b.close();print('PASS both sides required, rear blocked, fixed base/no base ghost, side checklist, correction and grouping')
