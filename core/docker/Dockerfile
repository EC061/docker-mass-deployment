FROM debian:bookworm

RUN apt-get update && apt-get install -y openssh-server sudo && rm -rf /var/lib/apt/lists/*

RUN mkdir /var/run/sshd

# Default environment variables
ENV USERNAME=defaultuser

# Configure SSH
RUN sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config

EXPOSE 22

# Create entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D"]
