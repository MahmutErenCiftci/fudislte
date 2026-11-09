;(function () {
  var theme = 'system'
  try {
    theme = localStorage.getItem('fudislte.theme') || 'system'
  } catch (e) {}
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
})()
