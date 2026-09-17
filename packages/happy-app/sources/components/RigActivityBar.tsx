import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { Metadata } from '@/sync/storageTypes';
import { getRigActivityIndicators } from '@/sync/rig';
import { t } from '@/text';

const iconByKey = {
    subagents: 'people-outline',
    workflows: 'git-network-outline',
    processes: 'terminal-outline',
    tasks: 'checkbox-outline',
} as const;

const labelByKey = {
    subagents: 'agents',
    workflows: 'workflows',
    processes: 'processes',
    tasks: 'tasks',
} as const;

/**
 * The counts of what a session still has running.
 *
 * With a `sessionId` it is a way in to the background-work screen, which names
 * each task and shows how far along the ones that fan out are. Without one — the
 * dev preview — it stays a plain readout, so the preview does not navigate into
 * a session that is not there.
 */
export const RigActivityBar = React.memo(function RigActivityBar({
    metadata,
    sessionId,
}: {
    metadata: Metadata | null;
    sessionId?: string;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const indicators = getRigActivityIndicators(metadata);
    if (indicators.length === 0) return null;

    const row = (
        <View style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 5,
            alignItems: 'center',
        }}>
            {indicators.map((indicator) => (
                <View key={indicator.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name={iconByKey[indicator.key]} size={12} color={theme.colors.textSecondary} />
                    <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {indicator.count}{indicator.queued ? ` +${indicator.queued} queued` : ''} {labelByKey[indicator.key]}
                    </Text>
                </View>
            ))}
            {sessionId ? (
                <Ionicons name="chevron-forward" size={11} color={theme.colors.textSecondary} />
            ) : null}
        </View>
    );

    if (!sessionId) return row;

    return (
        <Pressable
            onPress={() => router.push(`/session/${sessionId}/background`)}
            // The bar is a thin strip of small text; without this the tap target
            // is smaller than a fingertip.
            hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('backgroundActivity.title')}
        >
            {row}
        </Pressable>
    );
});
