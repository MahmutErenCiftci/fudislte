import { Alert, Button } from '@fudislte/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { createBrowserRouter, Link, Navigate, useLocation, useParams } from 'react-router'

import { AuthLayout, FullScreenMessage } from '../features/auth/AuthLayout'
import { LoginPage } from '../features/auth/LoginPage'
import { ChannelPage } from '../features/chat/ChannelPage'
import { MessagesPage } from '../features/chat/MessagesPage'
import { SearchPage } from '../features/chat/SearchPage'
import { MeetingPage } from '../features/meetings/MeetingPage'
import { MeetingsPage } from '../features/meetings/MeetingsPage'
import { RoomPage } from '../features/rooms/RoomPage'
import { RoomsPage } from '../features/rooms/RoomsPage'
import { HomePage } from '../features/home/HomePage'
import { AcceptInvitationPage } from '../features/invitations/AcceptInvitationPage'
import { settingsRoutes } from '../features/settings/routes'
import { SettingsLayout } from '../features/settings/SettingsLayout'
import { SetupPage } from '../features/setup/SetupPage'
import { useT } from '../i18n'
import { api, errorMessage, queryKeys } from '../lib/api'
import { useMe, useMeta } from '../lib/session'
import { AppShell } from '../shell/AppShell'
import { WorkspaceContext, type WorkspaceContextValue } from '../shell/context'
import { CreateWorkspaceDialog } from '../shell/WorkspaceSwitcher'

/** Sends visitors to setup, sign-in or their first workspace. */
function RootRedirect() {
  const t = useT()
  const meta = useMeta()
  const me = useMe()
  if (meta.isPending || me.isPending) return <FullScreenMessage>{t('common.loading')}</FullScreenMessage>
  if (meta.error) return <ServerUnavailable error={meta.error} />
  if (meta.data.setupRequired) return <Navigate to="/setup" replace />
  if (!me.data) return <Navigate to="/login" replace />
  const first = me.data.workspaces[0]
  if (!first) return <NoWorkspace />
  return <Navigate to={`/w/${first.organization.slug}`} replace />
}

function ServerUnavailable({ error }: { error: unknown }) {
  const t = useT()
  return (
    <AuthLayout title={t('app.unreachable')}>
      <div className="grid gap-4">
        <Alert variant="error">{errorMessage(error)}</Alert>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('app.tryAgain')}
        </Button>
      </div>
    </AuthLayout>
  )
}

function NoWorkspace() {
  const t = useT()
  const me = useMe()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const signOut = useMutation({ mutationFn: api.logout, onSettled: () => queryClient.setQueryData(queryKeys.me, null) })
  return (
    <AuthLayout title={t('app.noWorkspace')} description={t('app.noWorkspaceText')}>
      <div className="grid gap-3">
        <p className="text-[13px] text-muted-foreground">{t('app.askInvite')}</p>
        {me.data?.user.isInstanceAdmin && <Button onClick={() => setCreateOpen(true)}>{t('shell.newWorkspace')}</Button>}
        <Button variant="outline" onClick={() => signOut.mutate()}>
          {t('shell.signOut')}
        </Button>
      </div>
      {me.data?.user.isInstanceAdmin && <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </AuthLayout>
  )
}

/** Requires a session and membership in the workspace named by the URL. */
function WorkspaceRoute() {
  const t = useT()
  const { slug } = useParams()
  const location = useLocation()
  const me = useMe()
  if (me.isPending) return <FullScreenMessage>{t('common.loading')}</FullScreenMessage>
  if (me.error) return <ServerUnavailable error={me.error} />
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
  const workspace = me.data.workspaces.find((w) => w.organization.slug === slug)
  if (!workspace) return <Navigate to="/" replace />
  return <WorkspaceProvider me={me.data} workspace={workspace} />
}

/** Provides the workspace; the value changes only with it, not with every URL change. */
function WorkspaceProvider({ me, workspace }: WorkspaceContextValue) {
  const value = useMemo(() => ({ me, workspace }), [me, workspace])
  return (
    <WorkspaceContext.Provider value={value}>
      <AppShell />
    </WorkspaceContext.Provider>
  )
}

function NotFound() {
  const t = useT()
  return (
    <AuthLayout title={t('app.notFound')}>
      <Button variant="outline" asChild className="w-full">
        <Link to="/">{t('invite.goHome')}</Link>
      </Button>
    </AuthLayout>
  )
}

export const router = createBrowserRouter([
  { path: '/', element: <RootRedirect /> },
  { path: '/setup', element: <SetupPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/invite/:token', element: <AcceptInvitationPage /> },
  {
    path: '/w/:slug',
    element: <WorkspaceRoute />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'c/:channelId', element: <ChannelPage /> },
      { path: 'messages', element: <MessagesPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'rooms', element: <RoomsPage /> },
      { path: 'r/:roomId', element: <RoomPage /> },
      { path: 'meetings', element: <MeetingsPage /> },
      { path: 'm/:meetingId', element: <MeetingPage /> },
      // Projects and whiteboards load on first use (drag and drop, Excalidraw).
      { path: 'tasks', lazy: () => import('../features/projects/MyTasksPage').then((m) => ({ Component: m.MyTasksPage })) },
      { path: 'projects', lazy: () => import('../features/projects/ProjectsPage').then((m) => ({ Component: m.ProjectsPage })) },
      { path: 'p/:projectId', lazy: () => import('../features/projects/ProjectPage').then((m) => ({ Component: m.ProjectPage })) },
      { path: 'boards', lazy: () => import('../features/boards/BoardsPage').then((m) => ({ Component: m.BoardsPage })) },
      { path: 'b/:boardId', lazy: () => import('../features/boards/BoardPage').then((m) => ({ Component: m.BoardPage })) },
      { path: 'settings', element: <SettingsLayout />, children: settingsRoutes },
    ],
  },
  { path: '*', element: <NotFound /> },
])
