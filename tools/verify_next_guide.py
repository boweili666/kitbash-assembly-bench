"""Live Next feedback regression; requires Playwright and a served simulator URL."""
import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader'])
 page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8144/?practice=1');page.wait_for_function('window.KBParts&&KBParts.ready()')
 page.evaluate('''()=>{
 window.fixture=(offset=0,outside=false,reverse=false,missing=false)=>{
  let parts=KBParts.answer().parts.filter(d=>d.step===0);if(missing)parts=parts.slice(0,1);
  KB.loadSceneData({objects:parts.map(d=>{let t=KBParts.nodeTransform(d.key,d.path[d.path.length-1]);return {id:KB.newId(),type:'part:'+d.key,name:d.name,p:t.p,r:t.r,s:[1,1,1]}})},true);
  KB.objectsRoot.children.forEach(n=>{if(n.userData.kbPending)KBParts.resolve(n)});
  let c=new THREE.Box3().setFromObject(KB.objectsRoot).getCenter(new THREE.Vector3());
  KB.objectsRoot.children.forEach(n=>{n.position.x+=(outside?0:13)-c.x;n.position.z-=c.z;n.updateMatrixWorld(true)});
  let n=KB.objectsRoot.children[1];if(n){n.position.z+=offset*KBParts.unitScale()/1000;if(reverse)n.rotateZ(Math.PI);n.updateMatrixWorld(true)}
  KB.resetHistory();
 };
 window.poses=()=>{let r={};KB.objectsRoot.traverse(n=>{if(KB.isPart(n)){n.updateWorldMatrix(true,false);r[n.userData.kbId]=n.matrixWorld.elements.slice()}});return r};
 }''')
 page.evaluate('KBAnswer.showNext()');assert page.locator('#nextGuide').get_attribute('data-state')=='workspace'
 page.evaluate('KBAnswer.hide();fixture(4);KBAnswer.showStep(0)');assert page.locator('#nextGuide').get_attribute('data-state')=='progress'
 page.evaluate("KB.emit('snapAttempt',{success:false,reason:'peg-on-peg'})")
 assert 'Two pegs' in page.locator('.ng-feedback').inner_text()
 page.evaluate('KB.pushSnapshot()');page.wait_for_timeout(450)
 assert page.locator('#nextGuide').get_attribute('data-state')!='success'
 page.evaluate('KBAnswer.hide();fixture();window.doneIndex=KBCheck.evaluate().steps.find(s=>s.complete).i;window.screw=KB.objectsRoot.children[1];window.home=screw.position.clone();screw.position.z+=.3;screw.updateMatrixWorld(true);KBAnswer.showStep(doneIndex)')
 page.evaluate('screw.position.copy(home);screw.updateMatrixWorld(true);KB.pushSnapshot()');page.wait_for_timeout(450)
 assert page.locator('#nextGuide').get_attribute('data-state')=='success'
 assert page.locator('#answerBar').is_hidden()
 page.wait_for_timeout(1700)
 assert page.locator('#nextGuide').get_attribute('data-state')=='waiting'
 page.locator('.ng-close').click();assert page.locator('#nextGuide').is_hidden()
 page.evaluate('KBAnswer.hide();fixture(4);KBAnswer.showStep(0)');page.set_viewport_size({'width':390,'height':700})
 assert page.locator('#nextGuide').evaluate('(e)=>e.getBoundingClientRect().right<=innerWidth && e.scrollWidth<=e.clientWidth')
 assert not errors,errors
 print('PASS workspace, progress/error detail, rejected connection, approximate not successful, completion dwell + waiting, close, narrow viewport; no page errors')
 b.close()
