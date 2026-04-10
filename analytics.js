(function() {
  let sessionId = sessionStorage.getItem('sessionId');
  let isNewSession = false;
  if (!sessionId) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      sessionId = crypto.randomUUID();
    } else {
      sessionId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    sessionStorage.setItem('sessionId', sessionId);
    isNewSession = true;
  }
  
  fetch('https://blog-analytics-worker.pranavbhadane279.workers.dev/track', { 
    method: 'POST', 
    body: JSON.stringify({ 
      path: window.location.pathname,
      sessionId: sessionId,
      isNewSession: isNewSession
    }), 
    headers: { 'Content-Type': 'application/json' } 
  }).catch(()=>console.log("Tracking blocked"));
})();
