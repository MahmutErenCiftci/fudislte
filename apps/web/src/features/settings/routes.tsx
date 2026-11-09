import { Navigate, type RouteObject } from 'react-router'

import { AccessSettings } from './AccessSettings'
import { AccountSettings } from './AccountSettings'
import { AuditLog } from './AuditLog'
import { RolesSettings } from './RolesSettings'
import { RoomsSettings } from './RoomsSettings'
import { SecuritySettings } from './SecuritySettings'
import { UsersSettings } from './UsersSettings'
import { WorkspaceSettings } from './WorkspaceSettings'

export const settingsRoutes: RouteObject[] = [
  { index: true, element: <Navigate to="account" replace /> },
  { path: 'account', element: <AccountSettings /> },
  { path: 'general', element: <WorkspaceSettings /> },
  { path: 'users', element: <UsersSettings /> },
  { path: 'roles', element: <RolesSettings /> },
  { path: 'access', element: <AccessSettings /> },
  { path: 'security', element: <SecuritySettings /> },
  { path: 'rooms', element: <RoomsSettings /> },
  { path: 'audit', element: <AuditLog /> },
]
