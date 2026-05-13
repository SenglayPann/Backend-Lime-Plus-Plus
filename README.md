# 🍋 Lime++ Backend

Backend API for Lime++ - A contribution verification and evaluation system.

## Tech Stack

- **Framework:** NestJS
- **Language:** TypeScript
- **Database:** PostgreSQL 15
- **Cache:** Redis 7
- **ORM:** Prisma
- **Auth:** JWT + Passport
- **Queue:** BullMQ
- **API Docs:** Swagger

## Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Databases

Make sure Docker Desktop is running, then:

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on `localhost:5432`
- Redis on `localhost:6379`

### 3. Configure Environment

Copy the example env file (already done if you cloned the repo):

```bash
cp .env.example .env
```

Default values are already set for local development.

### 4. Run the App

Apply schema migrations before starting the API:

```bash
npx prisma migrate deploy
npx prisma generate
```

```bash
# Development mode (with hot reload)
npm run start:dev

# Production mode
npm run start:prod
```

The API will be available at **http://localhost:3001**

## Docker Commands

```bash
# Start databases
docker-compose up -d

# Stop databases
docker-compose down

# View logs
docker-compose logs -f

# Reset databases (delete all data)
docker-compose down -v && docker-compose up -d

# Check container status
docker ps
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run start:dev` | Start in development mode with hot reload |
| `npm run start:prod` | Start in production mode |
| `npm run build` | Build the application |
| `npm run test` | Run unit tests |
| `npm run test:e2e` | Run end-to-end tests |
| `npm run lint` | Lint the codebase |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://lime_user:lime_password@localhost:5432/lime_db` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_SECRET` | Secret for JWT tokens | (set in .env) |
| `PORT` | Server port | `3001` |
| `NODE_ENV` | Environment | `development` |

## Project Structure

```
src/
├── app.module.ts       # Root module
├── app.controller.ts   # Root controller
├── app.service.ts      # Root service
└── main.ts             # Application entry point

prisma/
└── schema.prisma       # Database schema

test/
├── app.e2e-spec.ts     # E2E tests
└── jest-e2e.json       # Jest E2E config
```

## Troubleshooting

### Port 5432 already in use

Another PostgreSQL instance is running. Either stop it or change the port in `docker-compose.yml`.

### Cannot connect to database

1. Ensure Docker Desktop is running
2. Check containers are up: `docker ps`
3. Check logs: `docker-compose logs postgres`

### Prisma issues

```bash
# Regenerate Prisma client
npx prisma generate

# Apply pending schema migrations
npx prisma migrate deploy

# Reset database
npx prisma db push --force-reset
```

### GitHub sign-in returns AuthFailed

If GitHub accepts the credentials but the frontend redirects to
`/login?error=AuthFailed`, first check the backend profile endpoint:
`GET /api/v1/auth/me`. A 500 response usually means the local database schema
is behind the generated Prisma client. Apply the pending migrations and
restart the backend.
