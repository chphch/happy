import * as React from 'react';
import { SessionListViewItem, SessionRowData, useSessionListViewData, useSetting } from '@/sync/storage';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const result: SessionListViewItem[] = [];
        const inactiveSessions: SessionRowData[] = [];
        const starredActiveItems: SessionListViewItem[] = [];

        // First pass: keep the active-sessions block, collect inactive rows,
        // also surface starred-but-active sessions as standalone rows
        // (see buildSessionListViewData → Starred section).
        for (const item of data) {
            if (item.type === 'active-sessions') {
                result.push(item);
            } else if (item.type === 'session') {
                if (!item.session.active) {
                    inactiveSessions.push(item.session);
                } else if (item.session.starred) {
                    starredActiveItems.push(item);
                }
            }
        }

        // Render starred-active sessions as standalone rows immediately after
        // the active-sessions block, before the archive toggle.
        result.push(...starredActiveItems);

        if (inactiveSessions.length > 0) {
            result.push({ type: 'archive-toggle', hidden: hideInactiveSessions });
        }

        // If not hiding, add all remaining items (headers, project groups, inactive sessions)
        if (!hideInactiveSessions) {
            let pendingProjectGroup: SessionListViewItem | null = null;

            for (const item of data) {
                if (item.type === 'active-sessions') {
                    continue; // already added
                }

                if (item.type === 'project-group') {
                    pendingProjectGroup = item;
                    continue;
                }

                if (item.type === 'session') {
                    if (!item.session.active) {
                        if (pendingProjectGroup) {
                            result.push(pendingProjectGroup);
                            pendingProjectGroup = null;
                        }
                        result.push(item);
                    }
                    continue;
                }

                pendingProjectGroup = null;

                if (item.type === 'header') {
                    result.push(item);
                }
            }
        }

        return result;
    }, [data, hideInactiveSessions]);
}
