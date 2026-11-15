import { OrdersDashboard } from "@/components/orders/orders-dashboard";

export default function DashboardPage() {
  return (
    <div className="flex flex-1 flex-col bg-muted/40">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Dashboard
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            SignFlow
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
            Track custom signage orders from submission through production and
            installation, all in one place.
          </p>
        </header>

        <OrdersDashboard />
      </main>
    </div>
  );
}
