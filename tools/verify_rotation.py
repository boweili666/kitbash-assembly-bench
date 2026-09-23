"""Rotation batching and no-image-stream regression; Playwright + served simulator URL."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader']);page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 root=Path(__file__).resolve().parents[1]
 page.route('**/src/check.js',lambda route:route.fulfill(content_type='application/javascript',body=(root/'src/check.js').read_text().replace('    var users = collectParts()', '    window.heavyChecks=(window.heavyChecks||0)+1;\n    var users = collectParts()')))
 page.route('**/src/collide.js',lambda route:route.fulfill(content_type='application/javascript',body=(root/'src/collide.js').read_text().replace('  function test(node) {','  function test(node) { window.collisionChecks=(window.collisionChecks||0)+1;')))
 page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8144/?practice=1&share=1');page.wait_for_function('window.KBParts&&KBParts.ready()')
 page.evaluate('''()=>{
 KB.loadSceneData({objects:[{id:'arm-test',type:'part:arm_5in',name:'Arm',p:[13,0,0],r:[0,0,0],s:[1,1,1]}]},true);KB.resetHistory();KB.setSelection([KB.objectsRoot.children[0]]);KBCheck.evaluate();
 window.groupCalls=0;const group=KBCheck.groupReadySteps;KBCheck.groupReadySteps=function(){groupCalls++;return group()};window.changes=0;KB.onChange(()=>changes++);
 window.captures=0;KB.captureFrame=()=>{captures++;throw Error('unexpected capture')};window.postMessage({type:'kb:init',options:{frames:true,fps:60}},'*');window.postMessage({type:'kb:startFrames'},'*');
 }''')
 page.wait_for_timeout(700);page.evaluate('heavyChecks=0;collisionChecks=0;groupCalls=0;changes=0;window.before=KB.objectsRoot.children[0].quaternion.clone()')
 for i in range(12):page.keyboard.down('ArrowRight')
 page.wait_for_timeout(450)
 held=page.evaluate('({active:KB.interacting(),heavy:heavyChecks,collisions:collisionChecks,groups:groupCalls,changes,captures,turned:before.angleTo(KB.objectsRoot.children[0].quaternion)})');print('held',held)
 assert held['active'] and held['turned']>.1 and all(held[x]==0 for x in ['heavy','collisions','groups','changes','captures']),held
 page.keyboard.up('ArrowRight');page.wait_for_timeout(500)
 done=page.evaluate('({active:KB.interacting(),heavy:heavyChecks,collisions:collisionChecks,groups:groupCalls,changes,captures})');print('released',done);assert not done['active'] and done['groups']==1 and done['changes']==1 and done['collisions']==1 and done['captures']==0,done
 page.keyboard.press('Control+z');assert page.evaluate('before.angleTo(KB.objectsRoot.children[0].quaternion)')<1e-8
 page.evaluate('KB.setSelection([KB.objectsRoot.children[0]]);heavyChecks=0;collisionChecks=0;groupCalls=0;changes=0;KB.gizmo.setMode("rotate");KB.gizmo.dispatchEvent({type:"dragging-changed",value:true});KB.objectsRoot.children[0].rotateY(.2);KB.emit("move",KB.objectsRoot.children[0])')
 assert page.evaluate('KB.interacting()&&heavyChecks===0&&collisionChecks===0&&groupCalls===0')
 page.evaluate('KB.gizmo.dispatchEvent({type:"mouseUp"});KB.gizmo.dispatchEvent({type:"dragging-changed",value:false})');assert page.evaluate('!KB.interacting()&&groupCalls===1&&changes===1')
 page.evaluate('KB.setSelection([KB.objectsRoot.children[0]])');page.keyboard.down('ArrowLeft');page.evaluate('window.dispatchEvent(new Event("blur"))');assert not page.evaluate('KB.interacting()');page.keyboard.up('ArrowLeft')
 page.evaluate('KBTutorial.start()');page.wait_for_timeout(600)
 page.evaluate("window.arm=KB.objectsRoot.children.find(n=>n.name==='Arm');window.plate=KB.objectsRoot.children.find(n=>n.name==='Front Plate');KBMate.mate(arm,'H1',plate,'H6',-1,1)")
 page.wait_for_timeout(1700);assert page.evaluate('KBMate.locked(arm)')
 page.evaluate('heavyChecks=0;collisionChecks=0;groupCalls=0;changes=0')
 for i in range(8):page.keyboard.down('ArrowLeft')
 page.wait_for_timeout(400)
 assert page.evaluate('KB.interacting()&&heavyChecks===0&&collisionChecks===0&&groupCalls===0&&changes===0')
 page.keyboard.up('ArrowLeft');assert page.evaluate('!KB.interacting()&&changes===1&&groupCalls===1')
 print('PASS hole-locked arm rotation batches until key release')
 assert page.locator('#btnAgent').is_hidden();assert not errors,errors
 print('PASS keyboard repeat batching, one undo, gizmo batching, blur recovery, no screenshots even with legacy init/share/startFrames');b.close()
