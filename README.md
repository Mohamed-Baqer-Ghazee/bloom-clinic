# Bloom Skin Clinic — website + reservations

Runs entirely on this machine. Python 3 only, no installs.

```
cd website
python server.py            # normal start
python server.py --demo     # also fills today with sample bookings (for the pitch)
```

| Page | URL |
|---|---|
| Website + booking | http://localhost:8080 |
| Patient queue link | http://localhost:8080/q/CODE |
| Reception dashboard | http://localhost:8080/admin (PIN `1234`) |

Phones on the same Wi-Fi use the "On Wi-Fi" address printed at startup
(allow Python through Windows Firewall when prompted).

## Settings (environment variables)

- `BLOOM_PORT` (default 8080)
- `BLOOM_ADMIN_PIN` (default 1234)
- `BLOOM_DOCTOR`: the doctor's name shown in confirmations
- `BLOOM_PUBLIC_URL`: base URL used in WhatsApp links (default is the LAN IP)

Hours, closed days, capacity and the services list are constants at the top of `server.py`.

## How it works

- **Booking**: the patient picks a service, day and time, then enters name and phone. They get a booking code and a `/q/CODE` link.
- **Queue page**: shows the live position on the day of the appointment, refreshing every 15 s. The patient can confirm, reschedule or cancel after verifying the last 4 digits of their phone.
- **Reception**: today's list, status buttons (arrived → in session → done, no-show, cancel), "call next", walk-ins, and a WhatsApp button that opens a prefilled confirmation message.
- **Data**: `data/bloom.db` (SQLite). Delete the file to start fresh.

## Deploy to a server (Docker + automatic HTTPS)

1. Get any Linux VPS (Ubuntu 22.04/24.04) with ports 80 and 443 open.
2. DNS: add an **A record** for your domain pointing at the server's IP.
3. From this PC: `scp bloom-deploy.tar.gz root@SERVER_IP:~`
4. On the server:
   ```
   mkdir bloom && tar -xzf bloom-deploy.tar.gz -C bloom && cd bloom
   cp .env.example .env && nano .env      # set DOMAIN and BLOOM_ADMIN_PIN
   sh deploy.sh                           # installs Docker if needed, builds, starts
   ```
5. Open `https://YOUR_DOMAIN`. Caddy issues the certificate on the first request.

Update later: copy the new bundle over, extract it into the same folder, then `docker compose up -d --build`. Bookings are kept in the `bloom-data` volume.
Backup: `docker compose cp app:/app/data/bloom.db ./backup.db`
