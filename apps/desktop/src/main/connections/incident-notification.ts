import type { EventEmitter } from 'node:events';
type NativeNotification = EventEmitter & { show(): void; close(): void };
/** Native destination errors and runtime data never enter notification text. */
export function createIncidentNotifier(create: (options: {title:string;body:string}) => NativeNotification) {
  return ({phase}:{phase:'detected'|'cleared'}):Promise<void> => new Promise((resolve,reject)=>{
    let notification: NativeNotification;
    try {
      notification=create(phase==='detected'
        ? {title:'Catbots needs attention',body:'A runtime condition needs review. Open Deploy for details.'}
        : {title:'Catbots condition cleared',body:'A previously observed condition is no longer present. Review Deploy; this does not confirm account safety.'});
    } catch {reject(new Error('Notification unavailable'));return;}
    let settled=false;
    const finish=(shown:boolean)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      notification.removeAllListeners('show');notification.removeAllListeners('failed');
      if(shown)resolve();
      else {try {notification.close();} catch {} reject(new Error('Notification unavailable'));}
    };
    const timer=setTimeout(()=>finish(false),5000);
    timer.unref?.();
    notification.once('show',()=>finish(true));notification.once('failed',()=>finish(false));
    try {notification.show();} catch {finish(false);}
  });
}
