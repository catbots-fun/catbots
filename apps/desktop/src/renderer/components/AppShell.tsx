import { useEffect, useState, type ReactNode } from 'react';
import { BrandLogo, BrandWordmark } from './BrandLogo';
import { Sidebar, Breadcrumbs } from '@cloudflare/kumo';
import { PlugsConnectedIcon, ActivityIcon, DesktopIcon, DatabaseIcon, GearSixIcon, RobotIcon } from '@phosphor-icons/react';

export const appDestinations = ['bots', 'connections', 'nodes', 'data', 'activity', 'settings'] as const;
export type AppDestination = (typeof appDestinations)[number];

type AppShellProps = {
  surface?: 'desktop' | 'web';
  focused?: boolean;
  destination: AppDestination;
  onNavigate(destination: AppDestination): void;
  children: ReactNode;
};

const navigationItems: ReadonlyArray<{ destination: AppDestination; label: string; icon: typeof RobotIcon }> = [
  { destination: 'bots', label: 'Bots', icon: RobotIcon },
  { destination: 'connections', label: 'Connections', icon: PlugsConnectedIcon },
  { destination: 'nodes', label: 'Nodes', icon: DatabaseIcon },
  { destination: 'data', label: 'Data', icon: DatabaseIcon },
  { destination: 'activity', label: 'Activity', icon: ActivityIcon },
  { destination: 'settings', label: 'Settings', icon: GearSixIcon },
];

export function AppShell({ destination, onNavigate, children, surface = 'desktop', focused = false }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(focused), [focused]);
  const currentLabel = navigationItems.find((item) => item.destination === destination)?.label;
  return (
    <Sidebar.Provider open={!collapsed} onOpenChange={open=>setCollapsed(!open)} collapsible="icon" className={`kumo-app-shell${focused ? ' workspace-focused' : ''}`}>
      <Sidebar className="catbots-sidebar">
        <Sidebar.Header><div className="kumo-brand-row">{collapsed ? <BrandLogo decorative /> : <BrandWordmark />}<Sidebar.Trigger aria-label={collapsed?'Expand sidebar':'Collapse sidebar'}/></div></Sidebar.Header>
        <Sidebar.Content><Sidebar.Group><Sidebar.GroupLabel>Workspace</Sidebar.GroupLabel><Sidebar.Menu aria-label="Global navigation">
          {navigationItems.map(({destination:itemDestination,label,icon:Icon})=><Sidebar.MenuButton key={itemDestination} size="base" icon={Icon} active={destination===itemDestination} aria-label={label} onClick={()=>onNavigate(itemDestination)}>{label}{(itemDestination==='data'||itemDestination==='activity')&&<Sidebar.MenuBadge>Soon</Sidebar.MenuBadge>}</Sidebar.MenuButton>)}
        </Sidebar.Menu></Sidebar.Group></Sidebar.Content>
        <Sidebar.Footer>{!collapsed && <div className="sidebar-brand-note"><strong>See the logic.</strong><span>Your ideas. Your workspace.</span></div>}<Sidebar.Menu><Sidebar.MenuButton size="base" icon={DesktopIcon} disabled>Local workspace</Sidebar.MenuButton></Sidebar.Menu></Sidebar.Footer>
      </Sidebar>
      <div className="app-main kumo-app-main"><header className="kumo-app-topbar" hidden={focused}><Sidebar.Trigger aria-label="Toggle navigation"/><Breadcrumbs size="sm"><Breadcrumbs.Current>Workspace</Breadcrumbs.Current><Breadcrumbs.Separator/><Breadcrumbs.Current>{currentLabel}</Breadcrumbs.Current></Breadcrumbs><span className="workspace-mode"><DesktopIcon size={14} aria-hidden="true"/>{surface==='web'?'Browser · Local backend':'On device'}</span></header>{focused&&<div className="kumo-mobile-navigation"><Sidebar.Trigger aria-label="Toggle navigation"/></div>}<main className="app-content">{children}</main></div>
    </Sidebar.Provider>
  );
}
