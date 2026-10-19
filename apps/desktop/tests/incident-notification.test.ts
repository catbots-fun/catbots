import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createIncidentNotifier } from '../src/main/connections/incident-notification';
afterEach(()=>vi.useRealTimers());
it('waits for OS show confirmation and sends only fixed text',async()=>{
 const shown:string[]=[];
 const notify=createIncidentNotifier(options=>{shown.push(JSON.stringify(options));const event=new EventEmitter();return Object.assign(event,{show:()=>{event.emit('show');},close:()=>{}});});
 await notify({phase:'detected'});
 expect(shown).toEqual([JSON.stringify({title:'Catbots needs attention',body:'A runtime condition needs review. Open Deploy for details.'})]);
});
it('rejects failed delivery and bounds a silent OS destination',async()=>{
 vi.useFakeTimers();let closed=false;
 const notify=createIncidentNotifier(()=>Object.assign(new EventEmitter(),{show:()=>{},close:()=>{closed=true;}}));
 const result=notify({phase:'cleared'}).then(()=>false,()=>true);
 await vi.advanceTimersByTimeAsync(5000);expect(await result).toBe(true);expect(closed).toBe(true);
 const failing=createIncidentNotifier(()=>{const event=new EventEmitter();return Object.assign(event,{show:()=>{event.emit('failed',{},'SECRET');},close:()=>{}});});
 await expect(failing({phase:'detected'})).rejects.toThrow('Notification unavailable');
});
