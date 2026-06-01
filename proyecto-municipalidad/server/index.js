import './lib/env.js'
import { getApp } from './app.js'

const PORT = Number(process.env.PORT || 8787)

getApp()
  .then((app) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Municipal RAG + GTFS API listening on 0.0.0.0:${PORT}`)
    })
  })
  .catch((error) => {
    console.error('Failed to start server:', error)
    process.exitCode = 1
  })
