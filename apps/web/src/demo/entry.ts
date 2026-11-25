// Entry point of the demo build (vite --mode demo). Modules run in import order, so the
// fake backend is in place before the app's API client is created.
import './install'
import '../main'

import { showDemoBanner } from './banner'

showDemoBanner()
