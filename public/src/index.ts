interface StatusResponse {
  live: boolean;
  listeners: number;
}

const badge = document.getElementById('liveBadge') as HTMLElement;
const liveText = document.getElementById('liveText') as HTMLElement;

function checkStatus(): void {
  fetch('/api/status/hpam-english')
    .then(r => r.json() as Promise<StatusResponse>)
    .then(({ live, listeners }) => {
      if (live) {
        badge.classList.add('live');
        liveText.textContent = `Translator is LIVE · ${listeners} listening`;
      } else {
        badge.classList.remove('live');
        liveText.textContent = 'Translation not started yet';
      }
    })
    .catch(() => { liveText.textContent = 'Status unavailable'; });
}

checkStatus();
setInterval(checkStatus, 5000);
