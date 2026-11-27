import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { haversineM } from '@crewmap/shared/geo';
import { lang, t } from '@crewmap/shared/i18n';
import { PARKING } from '@crewmap/shared/parking';
import { formatClock, formatDistance, formatMinutes } from '@crewmap/shared/units';
import { engine } from '../core/engine';
import { forgetParked, noteParked, shareParked, stopWalk, useParking, walkToParked } from '../core/parking';
import { useApp } from '../core/store';
import { useBackClose } from '../ui/useBackClose';
import { Button, Card, Field, H, T } from '../ui/kit';
import { IconTile } from '../ui/screens-common/Icon';
import { palette, useTheme } from '../ui/theme';

/** Tapped parked car (D67): when, where, how far; Walk there, a note, Forget, and an explicit share with the crew. */
export default function ParkedSheet() {
  const router = useRouter();
  const th = useTheme();
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  useBackClose(close);
  const spot = useParking((s) => s.state.spot);
  const walking = useParking((s) => s.walk !== null);
  const fix = useApp((s) => s.fix);
  const crew = useApp((s) => s.circle);
  const [note, setNote] = useState(spot?.note ?? '');
  const [shared, setShared] = useState(false);
  useEffect(() => setNote(spot?.note ?? ''), [spot?.tripId]);
  if (!spot) return null;
  const distM = fix ? haversineM(fix, spot) : null;
  const meta = [
    t('park.parkedAt', { time: formatClock(spot.at) }),
    distM !== null ? `${formatDistance(distM, lang())} · ${formatMinutes(distM / 1.3)}` : null,
  ].filter(Boolean).join(' · ');
  const saveNote = () => {
    return note.trim() !== spot.note ? noteParked(note) : Promise.resolve();
  };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: th.bg }} contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <IconTile name="car" color={palette.brand} size={46} />
          <View style={{ flex: 1, gap: 2 }}>
            <H>{spot.street ?? (spot.kind === 'lot' ? t('park.lot') : t('park.title'))}</H>
            <T soft numberOfLines={1}>{meta}</T>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            {walking ? (
              <Button testID="parked-walk-stop" kind="secondary" label={t('park.walkStop')} onPress={stopWalk} />
            ) : (
              <Button
                testID="parked-walk"
                icon="walk"
                label={t('park.walk')}
                disabled={!fix}
                onPress={() => {
                  if (!fix) return;
                  void walkToParked(fix).then(close);
                }}
              />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Button
              testID="parked-forget"
              kind="ghost"
              label={t('park.forget')}
              onPress={() => {
                void forgetParked();
                close();
              }}
            />
          </View>
        </View>
        <Field
          testID="parked-note"
          label={t('park.note')}
          value={note}
          maxLength={PARKING.noteMax}
          onChangeText={setNote}
          onBlur={() => void saveNote()}
          onSubmitEditing={() => void saveNote()}
          returnKeyType="done"
        />
        {crew && (
          <Button
            testID="parked-share"
            kind="secondary"
            icon="users"
            label={t('park.shareWith', { crew: crew.name })}
            disabled={shared}
            onPress={() => {
              setShared(true);
              void saveNote()
                .then(() => shareParked((thread, text) => engine.chat.send(thread, text), crew.id))
                .then((ok) => {
                  if (!ok) setShared(false);
                });
            }}
          />
        )}
      </Card>
    </ScrollView>
  );
}
