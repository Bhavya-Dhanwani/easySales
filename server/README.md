# clientpipe

Production-ready Express backend generated using **create-backend-app**.

## Features

- **Language:** TypeScript
- **Module System:** ES Modules
- **Architecture:** Modular (Class Based)
- **Database:** MongoDB (Mongoose)
- **Auth:** Enabled (Multi Token (Access + Refresh))
- **Logger:** Pino Logger
- **Swagger Documentation:** Enabled (`/docs`)
- **Docker Support:** Enabled
- **Testing:** Jest

## Getting Started

### 1. Environment Setup
Copy `.env.example` to `.env` and update the variables:
```bash
cp .env.example .env
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Development Server
```bash
npm run dev
```


### 4. Docker Deployment
Run application and MongoDB with Docker Compose from the root directory:
```bash
docker-compose up --build
```



### API Documentation
Access Swagger UI at: `http://localhost:5000/docs`