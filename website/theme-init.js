// Applies the saved or the system theme before the page paints, so it never flashes.
;(function () {
  var theme = null
  try {
    theme = localStorage.getItem('fudislte.site.theme')
  } catch (e) {}
  var dark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', dark)
})()
