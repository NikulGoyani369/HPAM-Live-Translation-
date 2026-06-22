const badge = document.getElementById('liveBadge');
const liveText = document.getElementById('liveText');

function checkStatus() {
  fetch('/api/status/hpam-english')
    .then(r => r.json())
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
