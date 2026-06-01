export function userHasRole(user, role) {
  if (!user || !role) return false
  if (Array.isArray(user.roles) && user.roles.length) {
    return user.roles.includes(role)
  }
  return user.role === role
}

export function getUserRoles(user) {
  if (!user) return []
  if (Array.isArray(user.roles) && user.roles.length) {
    return [...new Set(user.roles)]
  }
  return user.role ? [user.role] : []
}
