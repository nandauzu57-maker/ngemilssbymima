create table if not exists public.orders (
  id uuid primary key,
  customer_name text not null,
  customer_email text not null default '',
  customer_country text not null check (customer_country in ('ID', 'MY')),
  total_amount bigint not null check (total_amount >= 0),
  total_amount_myr numeric(12, 2) check (total_amount_myr is null or total_amount_myr >= 0),
  payment_method text not null default 'qris' check (payment_method = 'qris'),
  status text not null default 'pending_payment' check (status in ('pending_payment', 'paid')),
  created_at timestamptz not null default now(),
  payment_verified_at timestamptz,
  delivery_token text not null unique
);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  course_id text not null,
  course_title text not null,
  quantity integer not null check (quantity > 0),
  unit_price bigint not null check (unit_price >= 0)
);

alter table public.orders
  add column if not exists total_amount_myr numeric(12, 2)
  check (total_amount_myr is null or total_amount_myr >= 0);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create index if not exists orders_pending_created_at_idx
  on public.orders (created_at desc) where status = 'pending_payment';
create index if not exists order_items_order_id_idx
  on public.order_items (order_id, id);
create index if not exists order_items_course_id_idx
  on public.order_items (course_id);
