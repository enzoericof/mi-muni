import '../server/lib/env.js'
import { getApp } from '../server/app.js'

export default async function handler(req, res) {
  const app = await getApp()
  return app(req, res)
}
