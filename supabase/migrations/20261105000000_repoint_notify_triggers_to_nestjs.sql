-- Repoint booking notification triggers from the Supabase Edge Functions to the NestJS API.
-- Run in the Supabase SQL editor (the migration history is not synced, so prefer that to db push).
-- The old functions keep working until they are removed, so this is safe to apply at any time
-- after https://rider-api.limpoporide.com is serving traffic.

CREATE OR REPLACE FUNCTION public.notify_new_booking_drivers()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  perform net.http_post(
    url := 'https://rider-api.limpoporide.com/notify-new-booking-drivers',
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(new.*),
      'old_record', null
    ),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 5000
  );

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_rider_booking_status_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform net.http_post(
    url := 'https://rider-api.limpoporide.com/notify-rider-booking-status',
    body := jsonb_build_object(
      'type', 'UPDATE',
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(new.*),
      'old_record', to_jsonb(old.*)
    ),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 5000
  );

  return new;
end;
$function$;

