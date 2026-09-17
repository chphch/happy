/**
 * What this session still has running in the background.
 *
 * The activity indicator says "3 running"; this screen answers which three, and
 * for the kinds that fan out, how far along they are. It paints from session
 * metadata immediately and then asks the agent to re-read its journals, because
 * the two differ in a way the user has to be able to see:
 *
 * - the **task list** only changes when the agent's Stop hook fires, i.e. at the
 *   end of a turn, so it can be minutes old and the header says how old;
 * - the **progress** inside each task is re-read from disk on every refresh, so
 *   a workflow's agent count moves while this screen is open.
 *
 * Refreshing needs the session online. When it is not, the metadata snapshot is
 * still shown — stale detail beats an empty screen — with the age made explicit.
 */

import * as React from 'react';
import { View, Text, ActivityIndicator, RefreshControl } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { ItemList } from '@/components/ItemList';
import { BackgroundTaskCard } from '@/components/BackgroundTaskCard';
import { Typography } from '@/constants/Typography';
import { useSession } from '@/sync/storage';
import { t } from '@/text';
import {
    fetchBackgroundActivityDetail,
    getBackgroundTaskItems,
    type BackgroundActivityDetail,
    type BackgroundTaskDetail,
} from '@/sync/backgroundActivity';
import { formatCompactDuration, orderForDisplay } from '@/utils/backgroundActivityFormat';

/** How often an open screen re-asks the agent. Journals move on this order. */
const POLL_INTERVAL_MS = 5000;
/** How often the elapsed times re-render, independent of any network call. */
const TICK_INTERVAL_MS = 1000;

export default React.memo(function SessionBackgroundScreen() {
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const { theme } = useUnistyles();
    const session = useSession(sessionId!);

    const [detail, setDetail] = React.useState<BackgroundActivityDetail | null>(null);
    const [refreshing, setRefreshing] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const [now, setNow] = React.useState(() => Date.now());
    // An unanswered RPC rejects on a timeout far longer than the poll interval,
    // so without this an offline session stacks up a request every 5 seconds.
    const inFlight = React.useRef(false);

    const metadataItems = getBackgroundTaskItems(session?.metadata);

    const refresh = React.useCallback(async () => {
        if (!sessionId || inFlight.current) return;
        inFlight.current = true;
        try {
            setDetail(await fetchBackgroundActivityDetail(sessionId));
            setFailed(false);
        } catch {
            // Offline, or an agent too old to answer. Either way the metadata
            // snapshot below is still worth showing, so this is not fatal.
            setFailed(true);
        } finally {
            inFlight.current = false;
        }
    }, [sessionId]);

    React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    // Elapsed times must keep counting even when nothing new arrives — a task
    // frozen at "3m" for ten minutes reads as a broken screen.
    React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
        return () => clearInterval(timer);
    }, []);

    const onPullToRefresh = React.useCallback(async () => {
        setRefreshing(true);
        await refresh();
        setRefreshing(false);
    }, [refresh]);

    // The RPC answer is richer, so it wins whenever we have one; metadata is
    // the fallback that makes the first paint instant and survives going offline.
    const tasks: BackgroundTaskDetail[] | null = detail
        ? detail.items
        : metadataItems;
    const ordered = tasks ? orderForDisplay(tasks) : null;
    const listAge = detail?.listedAt ? formatCompactDuration(now - detail.listedAt) : null;

    const message = (text: string) => (
        <View style={{ padding: 32, alignItems: 'center' }}>
            <Text style={{
                fontSize: 14,
                color: theme.colors.textSecondary,
                textAlign: 'center',
                ...Typography.default(),
            }}>
                {text}
            </Text>
        </View>
    );

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.groupped.background }}>
                <ActivityIndicator color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <ItemList
            refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onPullToRefresh} tintColor={theme.colors.textSecondary} />
            }
        >
            {ordered === null
                // No items field at all — this agent predates per-task reporting,
                // which is a different thing from "nothing is running".
                ? message(t('backgroundActivity.unsupported'))
                : ordered.length === 0
                    ? message(t('backgroundActivity.empty'))
                    : (
                        <>
                            {listAge ? (
                                <Text style={{
                                    fontSize: 12,
                                    color: theme.colors.textSecondary,
                                    paddingHorizontal: 20,
                                    paddingTop: 14,
                                    ...Typography.default(),
                                }}>
                                    {t('backgroundActivity.listedAgo', { ago: listAge })}
                                </Text>
                            ) : null}
                            {ordered.map((task) => (
                                <BackgroundTaskCard key={task.id} task={task} now={now} />
                            ))}
                            {failed ? (
                                <Text style={{
                                    fontSize: 12,
                                    color: theme.colors.textSecondary,
                                    paddingHorizontal: 20,
                                    paddingTop: 14,
                                    ...Typography.default(),
                                }}>
                                    {t('backgroundActivity.refreshUnavailable')}
                                </Text>
                            ) : null}
                        </>
                    )}
        </ItemList>
    );
});
