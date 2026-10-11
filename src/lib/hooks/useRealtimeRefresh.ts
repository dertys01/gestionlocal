import { useEffect, useRef } from 'react';
import { useSupabase } from '@/components/providers/SupabaseProvider';

/**
 * Rafraîchissement temps réel multi-caisses (Supabase Realtime).
 *
 * Quand une AUTRE caisse — ou un autre appareil du même tenant — écrit dans
 * l'une des `tables`, `onChange` est appelé, après un court debounce qui
 * regroupe la rafale d'écritures d'une même vente (sales, puis products, puis
 * le journal). Le serveur Realtime applique la RLS : un abonné ne reçoit que
 * les lignes qu'il peut déjà lire, et le filtre `user_id` restreint au tenant.
 *
 * INERTE tant que `NEXT_PUBLIC_REALTIME` ne vaut pas « 1 ». C'est un choix
 * d'exploitation — une connexion WebSocket par onglet ouvert, facturée par
 * Supabase — donc on n'ouvre aucun canal sans un accord explicite.
 *
 * Ce n'est PAS un état local fusionné : la base reste la seule source de
 * vérité, et le rafraîchissement relit les mêmes fonctions que d'habitude.
 * Un événement manqué (reconnexion) ne laisse donc jamais un chiffre faux,
 * seulement un écran en retard jusqu'au prochain geste.
 */
const ACTIF = process.env.NEXT_PUBLIC_REALTIME === '1';

/**
 * Colonne de tenant par table, pour le filtre Realtime.
 *
 * La plupart des tables portent `user_id`. Les tables restaurant, non :
 * `restaurant_orders` a `owner_id`, et `restaurant_order_items` n'a AUCUNE
 * colonne de tenant (elle appartient à une commande). Filtrer sur `user_id`
 * pour ces tables ne matchait jamais rien — le temps réel de la salle et de la
 * cuisine ne se déclenchait pas. `null` = pas de filtre, la RLS fait le tri.
 */
const COLONNE_TENANT: Record<string, string | null> = {
  restaurant_orders: 'owner_id',
  restaurant_reservations: 'owner_id',
  restaurant_order_items: null,
};

export function useRealtimeRefresh(tables: string[], onChange: () => void) {
  const { supabase, ownerId } = useSupabase();
  // La fonction de rafraîchissement change à chaque rendu ; on la lit par une
  // ref (mise à jour dans un effet, jamais pendant le rendu) pour ne pas
  // réabonner le canal à chaque fois.
  const cbRef = useRef(onChange);
  useEffect(() => { cbRef.current = onChange; });
  // Clé stable : l'identité du tableau `tables` change à chaque rendu.
  const cle = tables.join(',');

  useEffect(() => {
    if (!ACTIF || !ownerId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const declencher = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), 400);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let canal: any = supabase.channel(`gl:${cle}:${ownerId}`);
    for (const table of cle.split(',')) {
      const colonne = COLONNE_TENANT[table] === undefined ? 'user_id' : COLONNE_TENANT[table];
      const filtre = colonne ? { filter: `${colonne}=eq.${ownerId}` } : {};
      canal = canal.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...filtre },
        declencher,
      );
    }
    canal.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(canal);
    };
  }, [supabase, ownerId, cle]);
}
