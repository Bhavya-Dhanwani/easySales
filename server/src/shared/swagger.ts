import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';

const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'easySales API',
    version: '1.0.0',
    description: 'Multi-tenant AI business development agent. Authenticated routes live under /api/v1 and require a Bearer token; pass X-Organization-Id to pick an organization.'
  },
  servers: [
    { url: 'http://localhost:' + (process.env.PORT || 5000) + '/api', description: 'Development Server' }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      }
    }
  }
};

export function setupSwagger(app: Express) {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}
