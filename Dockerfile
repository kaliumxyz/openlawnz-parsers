FROM node:13
MAINTAINER openlawnz

# Create app directory
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
COPY package.json ./

RUN yarn install
# Bundle app source
COPY . .

# Label docker container
LABEL name="openlawnz"

EXPOSE 80